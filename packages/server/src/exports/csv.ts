import type { Cycle, Funder, Program } from '@grantspotter/core';
import { buildExportRows, EXPORT_FIELDS, type ExportRow } from './rows.js';

/**
 * Excel and LibreOffice execute a leading `=`, `+`, `-`, `@`, TAB or CR as a formula. A funder's
 * own text can start with any of them (`- Up to $5,000`, `@arrl`), and a formula that runs when a
 * colleague opens the file is a code-execution path out of a data file. Neutralise it.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

export function escapeCsvField(value: string): string {
  const safe = FORMULA_LEAD.test(value) ? `'${value}` : value;
  if (/[",\n\r]/.test(safe)) return `"${safe.replace(/"/g, '""')}"`;
  return safe;
}

/** RFC 4180: CRLF line endings, a trailing terminator, quotes only where required. */
export function toCsv(rows: Array<Record<string, string>>, columns: string[]): string {
  const out: string[] = [columns.map(escapeCsvField).join(',')];
  for (const row of rows) {
    out.push(columns.map((c) => escapeCsvField(row[c] ?? '')).join(','));
  }
  return `${out.join('\r\n')}\r\n`;
}

/**
 * The header, and the column order. This IS `EXPORT_FIELDS` — the shared vocabulary every format
 * in this package renders — rather than a second list free to drift from it.
 */
export const PROGRAM_CSV_COLUMNS: readonly string[] = EXPORT_FIELDS;

/**
 * Excel on Windows reads a BOM-less UTF-8 file in the system code page, so `ARDC’s` arrives as
 * `ARDCâ€™s` and every en dash in the corpus turns to mojibake. `toCsv` and `programsToCsv` stay
 * byte-pure so they compose and so tests can assert exact output; adding the BOM is an explicit
 * decision the download path makes with {@link programsToCsvFile}.
 */
export const CSV_UTF8_BOM = '﻿';

/** One rendered row. Exposed so a caller with `ExportRow`s in hand need not rebuild them. */
export function exportRowToCsvRow(row: ExportRow): Record<string, string> {
  return { ...row.cells };
}

/**
 * The programme CSV. Suppressed records cannot appear: this goes through `buildExportRows`, whose
 * first act is the unconditional `exportablePrograms` gate. Nothing here re-implements it.
 */
export function programsToCsv(
  programs: readonly Program[],
  funders: readonly Funder[],
  cyclesByProgramId: ReadonlyMap<string, Cycle[]>,
): string {
  const rows = buildExportRows(programs, funders, cyclesByProgramId).map(exportRowToCsvRow);
  return toCsv(rows, [...PROGRAM_CSV_COLUMNS]);
}

/** The same bytes, prefixed with the UTF-8 BOM — what a `.csv` download should serve. */
export function programsToCsvFile(
  programs: readonly Program[],
  funders: readonly Funder[],
  cyclesByProgramId: ReadonlyMap<string, Cycle[]>,
): string {
  return CSV_UTF8_BOM + programsToCsv(programs, funders, cyclesByProgramId);
}
