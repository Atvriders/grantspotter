/**
 * The XLSX workbook: the same 150 rows the CSV writes, in the format a club officer forwards to a
 * faculty advisor, plus the provenance that makes them checkable.
 *
 * TWO DEVIATIONS FROM THE TASK BRIEF, both forced by Task 1.
 *
 * 1. The brief consumed `programToCsvRow` and `PROGRAM_CSV_COLUMNS` from `csv.ts`. Task 1 moved
 *    row shaping OUT of `csv.ts` into `rows.ts` precisely so no second format would re-answer the
 *    three questions it settles (which records may leave, what a projected date is called, what an
 *    unstated obligation is called), and `programToCsvRow` no longer exists. This file therefore
 *    consumes `buildExportRows`, which means the unconditional `exportablePrograms` gate runs
 *    before a single cell is written and cannot be skipped from here.
 * 2. The brief's header row was the raw field keys. `rows.ts` ships `EXPORT_FIELD_LABELS` for
 *    "the formats that show them to a reader rather than to a parser" and names XLSX as one of
 *    them; the CSV keeps the raw keys because a parser reads it. A workbook is read by a person,
 *    so it gets the labels.
 *
 * WHY NO CELL IS A DATE. Excel stores a date as a timezone-less serial number, and every writer —
 * exceljs included — converts a JS `Date` into that serial through some zone. `rows.ts` has
 * already resolved each deadline into the funder's OWN calendar day (`2026-11-01T03:59Z` in
 * America/New_York is the funder's 31 October, and five rows in the corpus differ from their UTC
 * instant). Re-encoding that resolved day as a serial is exactly the step that would move it back,
 * and *late* is the dangerous direction — it tells an applicant they have a day they do not have.
 * So dates stay text, in ISO order, which still sorts correctly in a spreadsheet. Only the three
 * genuinely numeric fields become numbers, so they sum.
 */
import ExcelJS from 'exceljs';
import { unzipSync, zipSync } from 'fflate';
import type { Cycle, Funder, Program } from '@grantspotter/core';
import {
  buildExportRows,
  EXPORT_FIELDS,
  EXPORT_FIELD_LABELS,
  type ExportField,
  type ExportRow,
} from './rows.js';

export const OPPORTUNITIES_SHEET = 'Opportunities';
export const PROVENANCE_SHEET = 'Provenance';

/**
 * The only cells written as numbers. An amount the funder never stated stays EMPTY rather than
 * becoming 0: `Number('')` is 0, and a 0 in an amount column is a claim ("this award is worth
 * nothing") that no funder in this corpus has made.
 */
export const XLSX_NUMERIC_FIELDS: ReadonlySet<ExportField> = new Set<ExportField>([
  'amountMin',
  'amountMax',
  'indirectCostCapPct',
]);

const WIDE_FIELDS: ReadonlySet<ExportField> = new Set<ExportField>([
  'name',
  'summary',
  'deadlineNote',
  'restrictions',
  'deadlineBasis',
  'sourceUrl',
  'applyUrl',
]);

/** CONTRACT §9: every user-facing date renders with its provenance. A file is user-facing. */
const PROVENANCE_COLUMNS = [
  ['id', 'ID'],
  ['name', 'Programme'],
  ['status', 'Status'],
  ['sourceUrl', 'Source URL'],
  ['applyUrl', 'Apply URL'],
  ['lastVerifiedAt', 'Last verified'],
  ['verificationMethod', 'Verification method'],
  ['contentHash', 'Content hash'],
  ['disputedNote', 'Dispute'],
  ['disputedClaims', 'Disputed claims'],
  ['staleMirrorWarning', 'Stale mirror warning'],
] as const;

/**
 * A fixed timestamp, on purpose. exceljs writes `created`/`modified` into `docProps/core.xml`, so
 * leaving them at "now" would make two runs over identical data produce different bytes — and the
 * suppression proof in `xlsx.test.ts` is a BYTE comparison between the publishable set and the
 * publishable set plus all 553 suppressed records. A workbook that cannot be compared cannot be
 * proved clean. The epoch is not a claim about when anything was verified; `lastVerifiedAt`, which
 * is on both sheets, is.
 */
const FIXED_TIMESTAMP = new Date(0);

/**
 * THE FIXED TIMESTAMP ABOVE WAS NOT ENOUGH, AND THE PROOF IT UNDERWRITES WAS PASSING ON LUCK.
 *
 * `docProps/core.xml` was pinned; the ZIP CONTAINER was not. exceljs 4.4.0 wraps JSZip, and
 * `ZipWriter.append` calls `zip.file(name, data)` with no `date`, so JSZip stamps every entry with
 * `new Date()` as it writes. DOS timestamps have two-second granularity, so two back-to-back builds
 * on an idle machine land in one tick and the bytes match — which is why the byte-identity
 * suppression proof survived this long without ever being true. Load the machine and it fails.
 *
 * WHY THIS IS A LOCAL-TIME STRING AND NOT A `Date`. fflate packs the DOS stamp with `getHours()`,
 * `getDate()` and friends, all of which are LOCAL. `new Date(Date.UTC(1980, 0, 2))` — what zip.ts
 * uses for the packet — therefore yields different bytes in New York, Tokyo and UTC, so the
 * workbook would be reproducible on one machine but not between two. A date-time string with no
 * offset is parsed as local time, which pins the local getters to the same wall clock everywhere.
 *
 * WHY 2 JANUARY 1980 and not the epoch: DOS timestamps begin in 1980, and fflate 0.8.3 throws
 * "date not in range 1980-2099" below that. The 2nd, not the 1st, so no timezone can push it under.
 * Like FIXED_TIMESTAMP this is not a claim about when anything was verified; `lastVerifiedAt` is.
 */
export const XLSX_ARCHIVE_MTIME = '1980-01-02T00:00:00';

/**
 * Rebuild the package fflate's way, at a fixed mtime. Chosen over patching the DOS fields in the
 * bytes exceljs produced, because a patcher has to find the headers first, and `PK\x03\x04` occurs
 * inside deflated payloads: it would either mis-parse or need the full central-directory walk this
 * avoids. It is also the same move `zip.ts` already makes for the application packet.
 *
 * Entry order is preserved as stored — `[Content_Types].xml` leads an OPC package — because
 * `unzipSync` yields insertion order and none of these names are integer-like. The empty directory
 * entries JSZip emits are re-stored rather than deflated; a deflated zero-byte directory is two
 * bytes of nothing that some strict OPC readers have historically disliked.
 */
function withFixedArchiveTimestamps(book: Uint8Array): Buffer {
  const entries = unzipSync(book);
  const files: Record<string, [Uint8Array, { level: 0 | 6 }]> = {};
  for (const [name, bytes] of Object.entries(entries)) {
    files[name] = [bytes, { level: bytes.length === 0 ? 0 : 6 }];
  }
  return Buffer.from(zipSync(files, { mtime: XLSX_ARCHIVE_MTIME }));
}

function styleHeader(sheet: ExcelJS.Worksheet, columnCount: number): void {
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columnCount } };
}

function opportunitiesSheet(wb: ExcelJS.Workbook, rows: readonly ExportRow[]): void {
  const sheet = wb.addWorksheet(OPPORTUNITIES_SHEET);
  sheet.columns = EXPORT_FIELDS.map((field) => ({
    header: EXPORT_FIELD_LABELS[field],
    key: field,
    width: WIDE_FIELDS.has(field) ? 44 : 20,
  }));
  styleHeader(sheet, EXPORT_FIELDS.length);

  for (const row of rows) {
    const added = sheet.addRow(
      Object.fromEntries(
        EXPORT_FIELDS.map((field) => {
          const raw = row.cells[field];
          if (!XLSX_NUMERIC_FIELDS.has(field)) return [field, raw];
          return [field, raw === '' ? null : Number(raw)];
        }),
      ),
    );
    for (const field of XLSX_NUMERIC_FIELDS) {
      added.getCell(field).numFmt = '#,##0';
    }
    added.alignment = { vertical: 'top', wrapText: false };
  }
}

function provenanceSheet(wb: ExcelJS.Workbook, rows: readonly ExportRow[]): void {
  const sheet = wb.addWorksheet(PROVENANCE_SHEET);
  sheet.columns = PROVENANCE_COLUMNS.map(([key, header]) => ({
    header,
    key,
    width: key === 'contentHash' ? 68 : 32,
  }));
  styleHeader(sheet, PROVENANCE_COLUMNS.length);

  for (const { program } of rows) {
    sheet.addRow({
      id: program.id,
      name: program.name,
      status: program.trust.status,
      sourceUrl: program.trust.sourceUrl,
      applyUrl: program.applyUrl ?? '',
      lastVerifiedAt: program.trust.lastVerifiedAt,
      verificationMethod: program.trust.verificationMethod,
      contentHash: program.trust.contentHash,
      disputedNote: program.trust.disputed?.note ?? '',
      disputedClaims: (program.trust.disputed?.claims ?? [])
        .map((c) => `${c.claim} <${c.sourceUrl}>`)
        .join(' | '),
      staleMirrorWarning: program.trust.staleMirrorWarning ?? '',
    });
  }
}

/**
 * The programme workbook. Suppressed records cannot appear: this goes through `buildExportRows`,
 * whose first act is the unconditional `exportablePrograms` gate. Nothing here re-implements it.
 */
export async function programsToXlsx(
  programs: readonly Program[],
  funders: readonly Funder[],
  cyclesByProgramId: ReadonlyMap<string, Cycle[]>,
): Promise<Buffer> {
  const rows = buildExportRows(programs, funders, cyclesByProgramId);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'GrantSpotter';
  wb.lastModifiedBy = 'GrantSpotter';
  wb.created = FIXED_TIMESTAMP;
  wb.modified = FIXED_TIMESTAMP;

  opportunitiesSheet(wb, rows);
  provenanceSheet(wb, rows);

  return withFixedArchiveTimestamps(new Uint8Array(await wb.xlsx.writeBuffer()));
}
