/**
 * THE MACHINE DIRECTIVE DOES NOT LEAVE THE BUILDING — READ OFF THE BYTES, OVER BOTH CORPORA.
 *
 * `DeadlineSpec.note` carries `RECUR n_fixed_dates tz=America/Los_Angeles dates=02-01,04-01,07-01,
 * 09-01 | <the funder's prose>` on the records whose schedule this pipeline encodes. `cc64182`
 * removed that identifier from the record page. It was still in the files, and the files are the
 * copy that gets forwarded: measured on 2026-08-13, before the fix,
 *
 *   - SHIPPED corpus (`data/seed/`, what `importSeedIfEmpty` gives a fresh container): 7 of 143
 *     rows carried `RECUR ` in the `deadlineNote` column of `GET /api/exports/opportunities.csv`,
 *     and the same 7 cells in the XLSX;
 *   - FIXTURE corpus (703 records normalized out of `fixtures/`): 6 of 150, in both files.
 *
 * The `.ics` was clean, which is why nobody had noticed: the surface a subscriber checks least was
 * the one surface that had never printed it.
 *
 * WHY THIS FILE READS THE SHIPPED RECORDS AND NOT ONLY THE FIXTURES. Every other proof in this
 * directory is measured against the fixture corpus, which is the right population for a byte
 * comparison and the wrong one for "what does a student get". The two disagree here, by one
 * record and by which records. A test that only read the fixtures would have gone green on a
 * shipped file that still carried the directive — which is precisely the shape of failure that
 * kept this defect alive through four surfaces.
 *
 * THE ASSERTION IS AN ABSENCE PLUS AN ACCOUNTING. "No `RECUR ` in the bytes" alone would also pass
 * if the exports silently dropped the column, or the record, or the corpus — so each corpus is
 * also required to still carry its directives in the DATABASE, to render an English schedule for
 * every one of them, and to keep the funder's own prose where the funder wrote any.
 */
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { RECURRENCE_PREFIX, readDeadlineNote } from '@grantspotter/core';
import type { Cycle, Funder, Program } from '@grantspotter/core';
import { programsToCsv } from './csv.js';
import { programsToXlsx } from './xlsx.js';
import { buildExportRows } from './rows.js';
import { loadExportCorpus, loadShippedExportCorpus } from './testCorpus.js';

interface Corpus {
  label: string;
  programs: Program[];
  funders: Funder[];
  cycles: Map<string, Cycle[]>;
  /** Records whose `deadline.note` starts with the directive. Measured, and asserted below. */
  withDirective: number;
  size: number;
}

async function corpora(): Promise<Corpus[]> {
  const fixture = await loadExportCorpus();
  const shipped = loadShippedExportCorpus();
  return [
    {
      label: 'shipped (data/seed — what a fresh install serves)',
      programs: shipped.programs,
      funders: shipped.funders,
      cycles: shipped.cyclesByProgramId,
      withDirective: 7,
      size: 143,
    },
    {
      label: 'fixture (703 records normalized out of fixtures/)',
      programs: fixture.programs,
      funders: fixture.funders,
      cycles: fixture.cyclesByProgramId,
      withDirective: 6,
      size: 150,
    },
  ];
}

/** Every string in a workbook, both sheets, as the reader of that file would meet them. */
async function xlsxText(buffer: Buffer): Promise<string[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const out: string[] = [];
  wb.eachSheet((sheet) => {
    sheet.eachRow((row) => {
      row.eachCell((cell) => out.push(String(cell.value ?? '')));
    });
  });
  return out;
}

describe('the RECUR directive, over both corpora', () => {
  it('is in the records — this is the population the two files below are written from', async () => {
    for (const corpus of await corpora()) {
      expect(corpus.programs.length, corpus.label).toBe(corpus.size);
      const carrying = corpus.programs.filter((p) =>
        p.deadline.note.trim().startsWith(RECURRENCE_PREFIX),
      );
      expect(carrying.length, corpus.label).toBe(corpus.withDirective);
      // Every one of them parses. A directive this product emitted and cannot read back would be
      // dropped by `readDeadlineNote` — correctly — and the schedule would vanish from the file
      // with nothing saying so, which is a different defect wearing this one's clothes.
      for (const program of carrying) {
        expect(readDeadlineNote(program.deadline.note).rule, `${corpus.label} ${program.id}`)
          .toBeDefined();
      }
    }
  }, 90_000);

  it('appears nowhere in the CSV a user downloads', async () => {
    for (const corpus of await corpora()) {
      const csv = programsToCsv(corpus.programs, corpus.funders, corpus.cycles);
      const offending = csv.split('\n').filter((line) => line.includes(RECURRENCE_PREFIX));
      expect(offending, `${corpus.label}: ${String(offending.length)} row(s) still carry it`).toEqual([]);
      // Nor any of the other tokens the encoding is made of, which is what a reader actually
      // met: `tz=America/Los_Angeles`, `dates=02-01,04-01`, `window=10-30..12-30`.
      expect(csv).not.toMatch(/\btz=[A-Za-z]+\//);
      expect(csv).not.toMatch(/\bdates=\d{2}-\d{2}/);
      expect(csv).not.toMatch(/\bwindows?=\d{2}-\d{2}/);
    }
  }, 90_000);

  it('appears in no cell of the XLSX either', async () => {
    for (const corpus of await corpora()) {
      const cells = await xlsxText(await programsToXlsx(corpus.programs, corpus.funders, corpus.cycles));
      expect(cells.filter((c) => c.includes(RECURRENCE_PREFIX)), corpus.label).toEqual([]);
    }
  }, 90_000);

  it('leaves the schedule in the file, in English, on every record that encoded one', async () => {
    for (const corpus of await corpora()) {
      const rows = buildExportRows(corpus.programs, corpus.funders, corpus.cycles);
      const encoded = rows.filter((r) => r.program.deadline.note.trim().startsWith(RECURRENCE_PREFIX));
      expect(encoded.length, corpus.label).toBe(corpus.withDirective);
      for (const row of encoded) {
        const note = readDeadlineNote(row.program.deadline.note);
        // The rule, said the way the record page says it — one schedule, one wording.
        expect(row.cells.deadlineRule, `${corpus.label} ${row.cells.id}`).toBe(note.rule);
        expect(row.cells.deadlineRule).toMatch(/each year/);
        // And the funder's own sentences, wherever the record holds any.
        expect(row.cells.deadlineNote, `${corpus.label} ${row.cells.id}`).toBe(note.prose);
      }
      // Records with no directive are untouched: their note is still the funder's whole string.
      for (const row of rows.filter((r) => !r.program.deadline.note.trim().startsWith(RECURRENCE_PREFIX))) {
        expect(row.cells.deadlineNote).toBe(row.program.deadline.note.trim());
        expect(row.cells.deadlineRule).toBe('');
      }
    }
  }, 90_000);
});
