import { describe, expect, it } from 'vitest';
import {
  CSV_UTF8_BOM,
  escapeCsvField,
  PROGRAM_CSV_COLUMNS,
  programsToCsv,
  programsToCsvFile,
  toCsv,
} from './csv.js';
import { makeCycle, makeFunder, makeProgram, makeSuppressedProgram } from './testFixtures.js';

describe('toCsv', () => {
  it('emits a CRLF-terminated header row and quotes only what needs quoting', () => {
    const out = toCsv([{ a: 'one', b: 'two' }], ['a', 'b']);
    expect(out).toBe('a,b\r\none,two\r\n');
  });

  it('quotes fields containing a comma, a quote or a newline, doubling inner quotes', () => {
    const out = toCsv([{ a: 'x,y', b: 'he said "hi"', c: 'line1\nline2' }], ['a', 'b', 'c']);
    expect(out).toBe('a,b,c\r\n"x,y","he said ""hi""","line1\nline2"\r\n');
  });

  it('defuses spreadsheet formula injection by prefixing a single quote', () => {
    const out = toCsv([{ a: '=SUM(A1:A9)' }, { a: '+1' }, { a: '-1' }, { a: '@x' }], ['a']);
    expect(out).toBe("a\r\n'=SUM(A1:A9)\r\n'+1\r\n'-1\r\n'@x\r\n");
  });

  it('renders a missing key as an empty field rather than "undefined"', () => {
    const out = toCsv([{ a: 'one' }], ['a', 'b']);
    expect(out).toBe('a,b\r\none,\r\n');
  });

  it('emits a header and nothing else for an empty row set', () => {
    expect(toCsv([], ['a', 'b'])).toBe('a,b\r\n');
  });
});

describe('escapeCsvField', () => {
  it('neutralises every lead character Excel and LibreOffice treat as a formula', () => {
    // The guard goes on the VALUE, before quoting. `\r` also forces the field to be quoted, so
    // the apostrophe lands inside the quotes rather than at the start of the byte string.
    expect(escapeCsvField('=x')).toBe("'=x");
    expect(escapeCsvField('+x')).toBe("'+x");
    expect(escapeCsvField('-x')).toBe("'-x");
    expect(escapeCsvField('@x')).toBe("'@x");
    expect(escapeCsvField('\tx')).toBe("'\tx");
    expect(escapeCsvField('\rx')).toBe('"\'\rx"');
  });

  it('leaves an ordinary ISO date alone', () => {
    expect(escapeCsvField('2027-02-28')).toBe('2027-02-28');
  });
});

describe('programsToCsv', () => {
  it('writes one row per program, headed by the declared column list', () => {
    const out = programsToCsv([makeProgram()], [makeFunder()], new Map([['ardc-grants', [makeCycle()]]]));
    const lines = out.split('\r\n');
    expect(lines[0]).toBe(PROGRAM_CSV_COLUMNS.join(','));
    expect(lines.filter((l) => l.length > 0)).toHaveLength(2);
    expect(lines[1]).toContain('ardc-grants');
    expect(lines[1]).toContain('Amateur Radio Digital Communications');
    expect(lines[1]).toContain('2027-02-01');
    expect(lines[1]).toContain('2026-08-02');
  });

  it('renders an unknown funder id as an empty funder name instead of throwing', () => {
    const out = programsToCsv([makeProgram({ funderId: 'nope' })], [], new Map());
    expect(out.split('\r\n')[1]).toContain('ardc-grants');
  });

  it('flattens list fields with a semicolon so the cell stays one field', () => {
    const out = programsToCsv([makeProgram()], [makeFunder()], new Map());
    expect(out).toContain('club_via_fiscal_sponsor; school_lea; university');
  });

  /**
   * The gate again, at the format itself. `buildExportRows` already applies it, and this asserts
   * that CSV goes THROUGH `buildExportRows` rather than around it — which is the only way a later
   * format can be trusted to inherit the same refusal.
   */
  it('never writes a do_not_publish record, even when handed one directly', () => {
    const out = programsToCsv(
      [makeProgram(), makeSuppressedProgram()],
      [makeFunder()],
      new Map(),
    );
    expect(out).not.toContain('ardc-2019-award-11225');
    expect(out).not.toContain('do_not_publish');
    expect(out.split('\r\n').filter((l) => l.length > 0)).toHaveLength(2);
  });

  it('emits a header-only file when the filter matched nothing, rather than zero bytes', () => {
    const out = programsToCsv([], [], new Map());
    expect(out).toBe(`${PROGRAM_CSV_COLUMNS.join(',')}\r\n`);
  });
});

/**
 * Excel on Windows reads a BOM-less UTF-8 file as the system code page, so `ARDC’s` arrives as
 * `ARDCâ€™s`. The corpus is full of curly quotes and en dashes. `toCsv` stays byte-pure so the
 * unit tests can assert exact output; the BOM is a separate, explicit decision the download path
 * makes.
 */
describe('programsToCsvFile', () => {
  it('prefixes the UTF-8 BOM so a spreadsheet opens the file in the right encoding', () => {
    const out = programsToCsvFile([makeProgram()], [makeFunder()], new Map());
    expect(out.startsWith(CSV_UTF8_BOM)).toBe(true);
    expect(out.slice(CSV_UTF8_BOM.length)).toBe(programsToCsv([makeProgram()], [makeFunder()], new Map()));
  });

  it('leaves programsToCsv itself BOM-free, so it stays composable', () => {
    expect(programsToCsv([makeProgram()], [makeFunder()], new Map()).startsWith(CSV_UTF8_BOM)).toBe(
      false,
    );
  });
});
