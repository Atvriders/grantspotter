import { beforeAll, describe, expect, it } from 'vitest';
import type { Cycle, Program } from '@grantspotter/core';
import { expandCycles, observedCycles } from '@grantspotter/core';
import { BLOCKED_HOSTS, normalizeHost } from '../fetcher/blocklist.js';
import { DO_NOT_PUBLISH_TAG, isDoNotPublish } from '../normalize/index.js';
import { cycleHorizonEndISO } from '../review/index.js';
// `loadCorpus` normalizes the SAME committed fixtures the crawler parses, through the product's
// own source modules, normalizer and BOTH suppression gates. Six server suites already import it
// across this boundary for the same reason: a claim about the corpus is only worth making against
// the corpus. See `api/calendarRouter.test.ts` and `normalize/index.test.ts`.
import { loadCorpus, PROFILE_NOW_ISO } from '../../../../scripts/profile-corpus.js';
import { exportablePrograms } from './filter.js';
import { buildExportRows } from './rows.js';
import { PROGRAM_CSV_COLUMNS, programsToCsv } from './csv.js';

/**
 * THE EXPORT, RUN OVER THE REAL CORPUS, ASSERTED ON THE BYTES.
 *
 * Everything below is a property of the 150 publishable programmes the committed fixtures
 * produce, and unprovable against hand-written records: 553 suppressed records that must never
 * leave, 4 funder-published cycles among 243, `costShareRequired` false on ZERO of 150, and five
 * programmes whose deadline renders a different calendar day without the funder's own zone.
 *
 * These counts move when fixtures land. UPDATE them, never soften them, and check WHICH source
 * moved — `loadCorpus().loaded` carries the split per source.
 */

const NOW = PROFILE_NOW_ISO;

let corpus: Awaited<ReturnType<typeof loadCorpus>>;
let funders: Array<{ id: string; name: string; homepage: string }>;
let cyclesByProgramId: Map<string, Cycle[]>;
let csv: string;

/** Mirrors `review/index.ts`'s `writeCyclesFor`: a RECUR rule is projected, a stated window is not. */
function projectCycles(programs: Program[]): Map<string, Cycle[]> {
  const horizon = cycleHorizonEndISO(NOW);
  const map = new Map<string, Cycle[]>();
  for (const program of programs) {
    const cycles = [
      ...expandCycles(program, programs, NOW, horizon),
      ...observedCycles(program, programs, NOW, horizon),
    ];
    if (cycles.length > 0) map.set(program.id, cycles);
  }
  return map;
}

/** RFC 4180 reader, so the assertions below read the bytes back rather than trusting the writer. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
    } else field += ch;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function column(rows: string[][], name: string): string[] {
  const index = rows[0].indexOf(name);
  expect(index, `column ${name} must exist`).toBeGreaterThanOrEqual(0);
  return rows.slice(1).map((r) => r[index]);
}

beforeAll(async () => {
  corpus = await loadCorpus();
  // Every funder a record names. `loadCorpus` does not carry `Funder` rows, and the export's
  // funder lookup must not be the thing under test here.
  funders = [...new Set(corpus.programs.map((p) => p.funderId))].map((id) => ({
    id,
    name: `Funder ${id}`,
    homepage: 'https://example.com/',
  }));
  cyclesByProgramId = projectCycles(corpus.programs);
  csv = programsToCsv(corpus.programs, funders, cyclesByProgramId);
}, 60_000);

describe('the real corpus, exported', () => {
  it('is the population every count below is taken over', () => {
    expect(corpus.programs).toHaveLength(150);
    expect(corpus.suppressedPrograms).toHaveLength(553);
    expect(corpus.programs.filter(isDoNotPublish)).toEqual([]);
  });

  it('writes exactly one data row per publishable programme', () => {
    const rows = parseCsv(csv);
    expect(rows[0]).toEqual([...PROGRAM_CSV_COLUMNS]);
    expect(rows).toHaveLength(151); // header + 150
    expect(new Set(column(rows, 'id')).size).toBe(150);
  });

  it('projects 243 cycles over 122 programmes, of which exactly 4 are funder-published', () => {
    const all = [...cyclesByProgramId.values()].flat();
    expect(all).toHaveLength(243);
    expect(cyclesByProgramId.size).toBe(122);
    expect(all.filter((c) => !c.isEstimated)).toHaveLength(4);
  });
});

/**
 * THE SUPPRESSION BOUNDARY. ~553 records are stored deliberately — past ARDC/NSF/USAspending
 * awards, the 37 ARRL clubs already funded, the cross-check rows — and a CSV is the least
 * recoverable place one could surface. The gate has leaked four times in this repo, every time
 * because a read path wrote its own filter instead of calling `isDoNotPublish`.
 */
describe('no suppressed record can leave the building', () => {
  it('writes not one of the 553 suppressed ids into the bytes', () => {
    const leaked = corpus.suppressedPrograms.filter((p) => csv.includes(p.id));
    expect(leaked.map((p) => p.id)).toEqual([]);
  });

  it('writes not one of their names either', () => {
    const publishable = new Set(corpus.programs.map((p) => p.name));
    const leaked = corpus.suppressedPrograms
      .filter((p) => !publishable.has(p.name))
      .filter((p) => csv.includes(p.name));
    expect(leaked.map((p) => p.name)).toEqual([]);
  });

  it('never writes the suppression tag, which would mean one got through', () => {
    expect(csv).not.toContain(DO_NOT_PUBLISH_TAG);
  });

  it('refuses them when they are handed straight to the writer alongside the real corpus', () => {
    const mixed = programsToCsv(
      [...corpus.programs, ...corpus.suppressedPrograms],
      funders,
      cyclesByProgramId,
    );
    expect(parseCsv(mixed)).toHaveLength(151);
    expect(mixed).toBe(csv);
  });

  /**
   * THE GATE, OVER BOTH POPULATIONS AT ONCE. This used to hand the mixed list to
   * `applyExportFilter` under half a dozen filter shapes, on the reasoning that a user-supplied
   * filter must never be able to reach a suppressed record. That filter engine is gone — the
   * export selects through the browse projection now, in the browse screen's own vocabulary — so
   * the claim is made where it is still exactly true: `exportablePrograms` is what every export
   * path runs the corpus through, it takes no argument, and there is no query that changes its
   * answer. The route-level version of the same claim, with a real projection and every filter a
   * user can express, is `exports/parityWithBrowse.test.ts` and `api/exportsCorpus.test.ts`.
   */
  it('refuses all 553 of them, and cannot be handed an argument that changes that', () => {
    const all = [...corpus.programs, ...corpus.suppressedPrograms];
    const kept = exportablePrograms(all);
    expect(kept.filter(isDoNotPublish)).toEqual([]);
    expect(kept).toHaveLength(corpus.programs.length);
    expect(exportablePrograms(kept)).toEqual(kept);
  });
});

describe('the bytes do not lie about deadlines', () => {
  it('labels every projected date as projected and never as the funder’s own', () => {
    const basis = column(parseCsv(csv), 'deadlineBasis');
    const counts = basis.reduce<Record<string, number>>((acc, v) => {
      acc[v] = (acc[v] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts['funder-published']).toBe(4);
    expect(counts['projected (estimated by GrantSpotter, not the funder)']).toBe(118);
    expect(counts['']).toBe(28);
    expect(Object.keys(counts).sort()).toEqual([
      '',
      'funder-published',
      'projected (estimated by GrantSpotter, not the funder)',
    ]);
  });

  it('carries the funder’s own calendar day for the five programmes the zone moves', () => {
    const rows = parseCsv(csv);
    const ids = column(rows, 'id');
    const closes = column(rows, 'nextCloses');
    const utc = column(rows, 'nextClosesUtc');
    const zones = column(rows, 'timezone');

    // ARRL Amateur Radio Grants: a Feb 1-28 window in America/New_York closing 23:59 local. The
    // stored instant is the 1st of the following month in UTC; the funder published the 31st.
    const arrl = ids.findIndex((id) => id.startsWith('arrl-amateur-radio-grants--'));
    expect(arrl).toBeGreaterThanOrEqual(0);
    expect(utc[arrl]).toBe('2026-11-01T03:59:00.000Z');
    expect(zones[arrl]).toBe('America/New_York');
    expect(closes[arrl]).toBe('2026-10-31');
    expect(closes[arrl]).not.toBe('2026-11-01');

    // ARDC: 23:59 America/Los_Angeles, stored as the next UTC day.
    const ardc = ids.findIndex((id) => id.startsWith('ardc-grants--apply--'));
    expect(utc[ardc]).toBe('2026-09-02T06:59:00.000Z');
    expect(closes[ardc]).toBe('2026-09-01');
  });

  it('renders a different day from the UTC instant for exactly the programmes it should', () => {
    const rows = parseCsv(csv);
    const closes = column(rows, 'nextCloses');
    const utc = column(rows, 'nextClosesUtc');
    const shifted = closes.filter((day, i) => day !== '' && day !== utc[i].slice(0, 10));
    expect(shifted).toHaveLength(5);
  });
});

/**
 * `costShareRequired` is unstated on 148 of 150 and `false` on ZERO. A renderer that collapsed
 * absent into "not required" would publish a claim no funder in this corpus has ever made, 148
 * times, in a file the user mails to a colleague.
 */
describe('the bytes do not lie about obligations', () => {
  it('never renders an unstated obligation as "not required"', () => {
    const rows = parseCsv(csv);
    const costShare = column(rows, 'costShareRequired');
    const coFunder = column(rows, 'coFunderPreference');
    const counts = costShare.reduce<Record<string, number>>((acc, v) => {
      acc[v] = (acc[v] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts['unstated']).toBe(148);
    expect(counts['required']).toBe(2);
    expect(counts['not required'] ?? 0).toBe(0);
    expect(coFunder.filter((v) => v === 'not preferred')).toEqual([]);
    expect(coFunder.every((v) => v === 'unstated' || v === 'preferred')).toBe(true);
  });
});

/**
 * farweb.org was the Foundation for Amateur Radio. The domain was taken over and now 301s to an
 * Indonesian gambling site, while QCWA, ARRL and club pages still tell applicants to "apply at the
 * FAR website". The corpus carries a deliberate SAFETY WARNING record to intercept that
 * instruction. It must reach the export as a warning, and no cell may carry the hijacked host.
 */
describe('the compromised-domain warning exports as a warning, never as an opportunity', () => {
  it('carries the warning record with a status no reader would apply against', () => {
    const rows = parseCsv(csv);
    const ids = column(rows, 'id');
    const i = ids.findIndex((id) => id.includes('far-farweb-org-compromised'));
    expect(i, 'the FAR safety-warning record must be in the export').toBeGreaterThanOrEqual(0);
    expect(column(rows, 'status')[i]).toBe('discontinued');
    expect(column(rows, 'name')[i]).toContain('do not apply');
    expect(column(rows, 'summary')[i]).toContain('SAFETY WARNING');
    expect(column(rows, 'applyUrl')[i]).not.toContain('farweb.org');
  });

  it('writes no URL on a blocklisted host anywhere in the file', () => {
    const rows = parseCsv(csv);
    for (const field of ['applyUrl', 'sourceUrl']) {
      for (const value of column(rows, field)) {
        if (value === '') continue;
        expect(
          BLOCKED_HOSTS.includes(normalizeHost(value)),
          `${field} ${value} is on the fetcher blocklist`,
        ).toBe(false);
      }
    }
  });

  it('writes the hijacked host nowhere in the bytes, in any cell', () => {
    expect(csv).not.toMatch(/farweb\.org/i);
    expect(csv).not.toMatch(/batualam/i);
  });
});

describe('rows and CSV describe the same export', () => {
  it('builds one row object per written line', () => {
    const rows = buildExportRows(corpus.programs, funders, cyclesByProgramId);
    expect(rows).toHaveLength(150);
    expect(rows.map((r) => r.cells.id)).toEqual(column(parseCsv(csv), 'id'));
  });
});
