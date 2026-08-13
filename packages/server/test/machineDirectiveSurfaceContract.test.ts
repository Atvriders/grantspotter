/**
 * ONE STRING, FOUR SURFACES, THREE ROUNDS — AND THE CHECK THAT WOULD HAVE TAKEN ALL FOUR AT ONCE.
 *
 * `DeadlineSpec.note` carries `RECUR n_fixed_dates tz=America/Los_Angeles dates=02-01,04-01,
 * 07-01,09-01 | <the funder's prose>`. Nobody wrote that; `normalize/deadline.ts` emits it so that
 * `parseRecurrence` can project a calendar. It reached readers on four surfaces and was removed
 * from one surface per round:
 *
 *   cc64182   the record page          — `readDeadlineNote` added to `web/src/lib/programWords.ts`
 *   313f4c7   the review queue         — the Inbox restated the split, then imported that reader
 *   f0518b2   the CSV and the XLSX     — the reader MOVED to core so the server could reach it
 *
 * Each round fixed the surface in front of it and asked no question about the others, because each
 * round's evidence was a string somebody had noticed. THIS FILE ASKS THE OTHER QUESTION: not
 * "where else does `RECUR` appear" — that is the search which found three answers on three
 * separate days — but "what is the complete list of places a person reads words out of this
 * product, and does the check run on all of them". The list is {@link SURFACES}, it is guarded for
 * completeness against the route table and against the web tree, and every assertion below runs
 * over all of it at once. A fifth surface added without an entry here fails
 * `covers every route that hands a person a document`, not a fourth round of this defect.
 *
 * IT FOUND A FIFTH SURFACE. `web/src/routes/Calendar.tsx` printed `program.deadlineNote` raw in
 * the "No dated cycle" list — `GET /api/calendar` sends `deadline.note` whole, the same field the
 * record page, the Inbox and the spreadsheets all read through core's reader, and this one
 * consumer did not. No record in either corpus routes a directive there TODAY (measured: 0 of the
 * 7 shipped records carrying one, 0 of the 6 fixture ones — a directive that parses projects a
 * cycle, and a record with a cycle is not undated), so every corpus-measured check in this repo,
 * including the one written in round three, was green on it. It is reachable all the same:
 * `core/test/cycles.test.ts` pins the shape `RECUR` "pasted here by accident" onto a kind that
 * projects nothing, and a curator who does that puts `dates=02-01` on the calendar page. That is
 * why {@link theConstructionProof} exists beside the corpus census: A CORPUS CHECK PROVES WHAT
 * TODAY'S DATA DOES, AND A SURFACE THAT IS CLEAN ONLY BECAUSE OF TODAY'S DATA IS NOT CLEAN.
 *
 * WHY THE VOCABULARY IS DERIVED AND THE SURFACES ARE LISTED, AND NOT THE OTHER WAY AROUND. A
 * hand-written list of forbidden strings is what let this walk: `RECUR` was on such a list from
 * round one, and the list was consulted on one surface at a time. So the tokens here are read OFF
 * THE RECORDS (`storedIdentifiers`) and off core's own grammar (`RECURRENCE_PREFIX`), and go stale
 * only if the corpus does; the thing that is enumerated by hand is the set of surfaces, which is
 * the set that was incomplete.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import ExcelJS from 'exceljs';
import type Database from 'better-sqlite3';
import { beforeAll, describe, expect, it } from 'vitest';
import { RECURRENCE_PREFIX } from '@grantspotter/core';
import type { Cycle, Funder, Profile, Program } from '@grantspotter/core';
import { PROFILES } from '../../../scripts/profile-corpus.js';
import { programsToCsv } from '../src/exports/csv.js';
import { programsToXlsx } from '../src/exports/xlsx.js';
import { buildIcsCalendar } from '../src/exports/ics.js';
import { buildEligibilityReport, eligibilityReportToCsv } from '../src/exports/eligibility.js';
import { renderEligibilityReportHtml } from '../src/exports/html.js';
import { strFromU8, unzipSync } from 'fflate';
import {
  buildApplicationPacket,
  budgetWorksheetCsv,
  requirementsChecklistMarkdown,
  sourceLinksMarkdown,
} from '../src/exports/zip.js';
import { markdownToDraft } from '../src/exports/draft.js';
import {
  loadExportCorpus,
  loadShippedExportCorpus,
  SHIPPED_NOW_ISO,
} from '../src/exports/testCorpus.js';
import { PROFILE_NOW_ISO } from '../../../scripts/profile-corpus.js';
import { openTestDb } from '../src/test/testDb.js';
import { createFunderRepo } from '../src/db/repositories/funders.js';
import { createProgramRepo } from '../src/db/repositories/programs.js';
import { createCalendarRouter } from '../src/api/calendarRouter.js';
import { errorHandler, requestIdMiddleware } from '../src/api/errors.js';
import type { RouterDeps, SessionUser } from '../src/api/deps.js';
import { makeFunder, makeProgram } from '../src/exports/testFixtures.js';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/* ------------------------------------------------------------------ what counts as a directive */

/**
 * The RECUR micro-format, in the two shapes a reader actually met it in.
 *
 * `RECURRENCE_PREFIX` is core's own constant rather than the literal `'RECUR '`, so a rename of
 * the marker cannot leave this file testing for a string the product no longer emits. The three
 * `key=value` patterns are the rest of what a person saw — `tz=America/Los_Angeles`,
 * `dates=02-01,04-01`, `window=10-30..12-30` — and they are checked separately because a
 * half-stripped directive that lost only its prefix is still not English.
 */
const DIRECTIVE_PATTERNS: ReadonlyArray<{ what: string; find: RegExp }> = [
  { what: 'the RECUR marker', find: new RegExp(RECURRENCE_PREFIX.trim(), 'g') },
  { what: 'a tz= parameter', find: /\btz=[A-Za-z]+\/[A-Za-z_]+/g },
  { what: 'a dates= parameter', find: /\bdates=\d{2}-\d{2}/g },
  { what: 'a window= parameter', find: /\bwindows?=\d{2}-\d{2}/g },
];

/** Every occurrence of the micro-format in one surface's text, as the strings a person would see. */
function directivesIn(text: string): string[] {
  return DIRECTIVE_PATTERNS.flatMap(({ find }) => [...text.matchAll(find)].map((m) => m[0]));
}

/**
 * THE STORAGE IDENTIFIERS THIS RECORD HOLDS — read off the record, never transcribed.
 *
 * `n_fixed_dates`, `cash_range`, `seed_import`, `external_spa_portal`, `ham_scholarship`: CONTRACT
 * §3's unions are how this product writes a fact down, not how it says one, and
 * `web/src/lib/programWords.ts` exists because printing them raw on the record page was its own
 * defect. Adding a member to any of those unions extends this set automatically, which a literal
 * list of tokens would not do.
 *
 * ONLY THE SNAKE_CASE ONES, AND THE OMISSION IS DELIBERATE RATHER THAN CONVENIENT. `rolling`,
 * `open`, `dormant`, `api`, `individual`, `teacher` and `university` are union members too, and a
 * reader meeting them in a spreadsheet cell cannot tell them from English because they ARE
 * English. The harm this file measures is an identifier a person can see is not a word anybody
 * wrote; `annual_window` in a column headed "Deadline pattern" is that, and `rolling` is not.
 * Claiming to police the single-word members would overstate what an underscore can detect.
 */
function storedIdentifiers(p: Program): string[] {
  return [
    p.deadline.kind,
    p.amount.instrument,
    p.aiPolicy.stance,
    p.trust.verificationMethod,
    p.applyVia,
    p.klass,
    p.trust.status,
    ...p.applicantEntities,
  ].filter((v) => v.includes('_'));
}

const SNAKE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;

/** Which stored identifiers a surface's text actually prints, and how often. */
function identifiersIn(text: string, vocabulary: ReadonlySet<string>): Map<string, number> {
  const hits = new Map<string, number>();
  for (const match of text.matchAll(SNAKE)) {
    if (vocabulary.has(match[0])) hits.set(match[0], (hits.get(match[0]) ?? 0) + 1);
  }
  return hits;
}

/* ------------------------------------------------------------------------------- the surfaces */

interface Corpus {
  label: string;
  programs: Program[];
  funders: Funder[];
  cyclesByProgramId: Map<string, Cycle[]>;
  nowISO: string;
}

/**
 * A place a person reads words out of this product.
 *
 * `produce` returns EVERY string that surface puts in front of a reader, joined — cells, lines,
 * event descriptions, JSON values. Not the bytes: a `.xlsx` is a zip archive and grepping it
 * proves nothing, so the workbook is opened and every cell of every sheet is read the way the
 * spreadsheet's reader meets them.
 */
interface Surface {
  /** Stable key, used by the completeness guards and by the census. */
  id: string;
  /** What a person is looking at when they read this. */
  what: string;
  kind: 'export' | 'feed' | 'print' | 'packet' | 'wire';
  produce(corpus: Corpus): Promise<string>;
}

async function xlsxText(buffer: Buffer): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const out: string[] = [];
  workbook.eachSheet((sheet) => {
    sheet.eachRow((row) => {
      row.eachCell((cell) => out.push(String(cell.value ?? '')));
    });
  });
  return out.join('\n');
}

/** The profile the two eligibility surfaces are rendered for. Any profile renders every row. */
const REPORT_PROFILE: Profile = PROFILES[0].profile;

function fundersById(corpus: Corpus): Map<string, Funder> {
  return new Map(corpus.funders.map((f) => [f.id, f]));
}

/**
 * EVERY SURFACE, AND THE LIST IS THE POINT OF THE FILE.
 *
 * Ordered by how far the words travel from this process: the two spreadsheets a student forwards,
 * the subscription feed that re-downloads onto a phone, the report that gets printed, the packet
 * that gets read while writing an application, and the wire the browser turns into a page.
 */
const SURFACES: readonly Surface[] = [
  {
    id: 'opportunities.csv',
    what: 'the opportunities spreadsheet a student downloads and forwards to a faculty advisor',
    kind: 'export',
    produce: (c) => Promise.resolve(programsToCsv(c.programs, c.funders, c.cyclesByProgramId)),
  },
  {
    id: 'opportunities.xlsx',
    what: 'the same spreadsheet as a workbook, both sheets, cell by cell',
    kind: 'export',
    produce: async (c) => xlsxText(await programsToXlsx(c.programs, c.funders, c.cyclesByProgramId)),
  },
  {
    id: 'deadlines.ics',
    what: 'the calendar subscription, which re-downloads into a device the reader carries',
    kind: 'feed',
    produce: (c) =>
      Promise.resolve(
        buildIcsCalendar({
          calendarName: 'GrantSpotter deadlines',
          cycles: [...c.cyclesByProgramId.values()].flat(),
          programsById: new Map(c.programs.map((p) => [p.id, p])),
          nowISO: c.nowISO,
        }),
      ),
  },
  {
    id: 'eligibility.csv',
    what: 'the eligibility report as a spreadsheet',
    kind: 'export',
    produce: (c) =>
      Promise.resolve(
        eligibilityReportToCsv(
          buildEligibilityReport(
            REPORT_PROFILE,
            c.programs,
            c.funders,
            c.cyclesByProgramId,
            c.nowISO,
          ),
        ),
      ),
  },
  {
    id: 'eligibility.html',
    what: 'the eligibility report as the page a student opens and prints or saves as a PDF',
    kind: 'print',
    produce: (c) =>
      Promise.resolve(
        renderEligibilityReportHtml(
          buildEligibilityReport(
            REPORT_PROFILE,
            c.programs,
            c.funders,
            c.cyclesByProgramId,
            c.nowISO,
          ),
        ),
      ),
  },
  {
    id: 'packet/requirements-checklist.md',
    what: 'the requirements checklist in the application packet, read while writing the bid',
    kind: 'packet',
    produce: (c) => {
      const byId = fundersById(c);
      return Promise.resolve(
        c.programs.map((p) => requirementsChecklistMarkdown(p, byId.get(p.funderId))).join('\n'),
      );
    },
  },
  {
    id: 'packet/sources.md',
    what: 'the source-links sheet in the application packet',
    kind: 'packet',
    produce: (c) => {
      const byId = fundersById(c);
      return Promise.resolve(
        c.programs.map((p) => sourceLinksMarkdown(p, byId.get(p.funderId))).join('\n'),
      );
    },
  },
  {
    id: 'packet/budget-worksheet.csv',
    what: 'the budget worksheet in the application packet',
    kind: 'packet',
    produce: (c) => Promise.resolve(c.programs.map((p) => budgetWorksheetCsv([], p)).join('\n')),
  },
];

/* -------------------------------------------------------------------------------- the corpora */

let corpora: Corpus[];

beforeAll(async () => {
  const shipped = loadShippedExportCorpus();
  const fixture = await loadExportCorpus();
  corpora = [
    {
      label: 'shipped (data/seed — the 143 records a fresh install serves)',
      programs: shipped.programs,
      funders: shipped.funders,
      cyclesByProgramId: shipped.cyclesByProgramId,
      nowISO: SHIPPED_NOW_ISO,
    },
    {
      label: 'fixture (the 150 publishable records normalized out of fixtures/)',
      programs: fixture.programs,
      funders: fixture.funders,
      cyclesByProgramId: fixture.cyclesByProgramId,
      nowISO: PROFILE_NOW_ISO,
    },
  ];
}, 180_000);

/* ---------------------------------------------------------------------------- the assertions */

describe('the surfaces a person reads', () => {
  /**
   * VACUITY GUARD, AND IT IS FIRST FOR A REASON. Every other assertion in this file is an ABSENCE,
   * and a producer that returned an empty string — a format that threw and was caught, a corpus
   * that loaded as `[]` — would satisfy all of them in silence. That is the exact shape of the
   * failure this file exists to break, so the surfaces have to be shown carrying real content
   * before they are asked what they do not carry.
   */
  it('each produce real text naming real programmes, on both corpora', async () => {
    for (const corpus of corpora) {
      expect(corpus.programs.length, corpus.label).toBeGreaterThan(100);
      const names = corpus.programs.map((p) => p.name);
      for (const surface of SURFACES) {
        const text = await surface.produce(corpus);
        expect(text.length, `${corpus.label} / ${surface.id}`).toBeGreaterThan(500);
        expect(
          names.filter((n) => text.includes(n)).length,
          `${corpus.label} / ${surface.id} names no programme, so every absence proved below is ` +
            'the absence of a file rather than the absence of a directive',
        ).toBeGreaterThan(0);
      }
    }
  }, 180_000);

  it('carry no machine directive on either corpus', async () => {
    for (const corpus of corpora) {
      // The population first: an absence check over records that hold none is not evidence.
      const carrying = corpus.programs.filter((p) =>
        p.deadline.note.trim().startsWith(RECURRENCE_PREFIX),
      );
      expect(carrying.length, `${corpus.label} holds no directive to leak`).toBeGreaterThan(0);

      for (const surface of SURFACES) {
        const found = directivesIn(await surface.produce(corpus));
        expect(
          found,
          `${corpus.label} / ${surface.id} — ${surface.what} — printed ${String(found.length)} ` +
            'fragment(s) of the RECUR micro-format. Split the note with core\'s readDeadlineNote: ' +
            'the rule in English, the funder\'s prose as the funder wrote it, the directive nowhere.',
        ).toEqual([]);
      }
    }
  }, 180_000);
});

/* ----------------------------------------------------------------- the construction proof */

/**
 * A CORPUS OF DIRECTIVES ON PURPOSE — because a surface that is clean on today's data is not clean.
 *
 * Three records, chosen so that between them they reach every path a directive can travel:
 *
 *   `projecting`  a kind `expandCycles` projects, so it has a next cycle and appears in the
 *                 spreadsheets' dated columns, in the feed as a VEVENT, and in the packet.
 *   `undated`     a directive pasted onto a kind that projects NOTHING (`core/test/cycles.test.ts`
 *                 pins that this is tolerated and ignored). It therefore reaches the calendar's
 *                 undated list — the fifth surface — and no dated column anywhere.
 *   `noProse`     a note that is ONLY a directive, with no `|` and no funder sentence after it.
 *                 A splitter that takes everything after the bar returns the whole string here.
 */
const DIRECTIVE = `${RECURRENCE_PREFIX}n_fixed_dates tz=America/Los_Angeles dates=02-01,04-01,07-01,09-01`;

function plantedCorpus(): Corpus {
  const funder = makeFunder({ id: 'planted-funder', name: 'Planted Funder' });
  const programs: Program[] = [
    makeProgram({
      id: 'planted-projecting',
      funderId: funder.id,
      name: 'Planted Projecting Programme',
      deadline: {
        kind: 'n_fixed_dates',
        source: { kind: 'self' },
        note: `${DIRECTIVE} | Applications arriving after Sep 1 roll to the next Feb 1 cycle.`,
      },
    }),
    makeProgram({
      id: 'planted-undated',
      funderId: funder.id,
      name: 'Planted Undated Programme',
      // `dormant` projects no cycle, so this record can only ever be met in the undated list.
      deadline: {
        kind: 'dormant',
        source: { kind: 'self' },
        note: `${DIRECTIVE} | pasted here by accident`,
      },
    }),
    makeProgram({
      id: 'planted-no-prose',
      funderId: funder.id,
      name: 'Planted Directive-Only Programme',
      deadline: { kind: 'n_fixed_dates', source: { kind: 'self' }, note: DIRECTIVE },
    }),
  ];
  return {
    label: 'planted (three records built to carry a directive down every path)',
    programs,
    funders: [funder],
    cyclesByProgramId: new Map(),
    nowISO: SHIPPED_NOW_ISO,
  };
}

const MEMBER: SessionUser = { id: 'u-member', email: 'member@example.com', role: 'member' };

/** `GET /api/calendar`, over a real database holding the planted records. */
async function calendarResponse(corpus: Corpus): Promise<unknown> {
  const db: Database.Database = openTestDb();
  try {
    const funderRepo = createFunderRepo(db);
    for (const f of corpus.funders) funderRepo.upsert(f);
    const programRepo = createProgramRepo(db);
    for (const p of corpus.programs) programRepo.upsert(p);

    const deps: RouterDeps = {
      db,
      now: () => corpus.nowISO,
      requireAuth: (_req, _res, next) => next(),
      requireAdmin: (_req, _res, next) => next(),
      currentUser: () => MEMBER,
    };
    const app = express();
    app.use(express.json());
    app.use(requestIdMiddleware());
    app.use('/api/calendar', createCalendarRouter(deps));
    app.use(errorHandler({ logger: () => undefined }));
    const res = await request(app).get(
      `/api/calendar?from=${corpus.nowISO}&to=2027-08-04T00:00:00.000Z`,
    );
    expect(res.status).toBe(200);
    return res.body;
  } finally {
    db.close();
  }
}

export const theConstructionProof = 'see the describe block below';

describe('a directive planted on purpose', () => {
  it('reaches no reader on any document surface', async () => {
    const corpus = plantedCorpus();
    for (const surface of SURFACES) {
      const found = directivesIn(await surface.produce(corpus));
      expect(
        found,
        `${surface.id} — ${surface.what} — printed the directive when a record actually carried ` +
          'one down this path. Today\'s corpus does not route one here; that is a fact about ' +
          'the data, not about this surface.',
      ).toEqual([]);
    }
  }, 120_000);

  /**
   * THE FIFTH SURFACE. `GET /api/calendar`'s `undated[]` carries `deadline.note` verbatim, exactly
   * as `GET /api/programs/:id` does, and that is legitimate on the wire — the record page needs the
   * whole string in order to split it. What is not legitimate is a CONSUMER that prints it whole,
   * and `Calendar.tsx` was one. The wire assertion is therefore stated as a declaration
   * ("this field is raw by contract") and the guard that matters is `every consumer of a raw
   * field runs core's reader`, below.
   */
  it('rides the wire only in the one field declared raw, and reaches the undated list', async () => {
    const body = (await calendarResponse(plantedCorpus())) as {
      undated: Array<{ programId: string; deadlineNote: string }>;
      entries: unknown[];
    };
    const undated = body.undated.find((u) => u.programId === 'planted-undated');
    expect(
      undated,
      'the planted dormant record did not reach the undated list at all, so this test proves ' +
        'nothing about what that list prints',
    ).toBeDefined();
    expect(undated?.deadlineNote).toContain(RECURRENCE_PREFIX);

    // Every OTHER string on that response is the wire's own words and must be clean.
    const withoutRawNotes = JSON.stringify(body.undated.map(({ deadlineNote: _n, ...rest }) => rest));
    expect(directivesIn(withoutRawNotes)).toEqual([]);
    expect(directivesIn(JSON.stringify(body.entries))).toEqual([]);
  }, 60_000);

  /**
   * THE PACKET AS A FILE, NOT AS THREE FUNCTIONS.
   *
   * The three packet entries in {@link SURFACES} are the three that render record prose, and
   * calling their writers directly is the right way to run them over 143 records. It leaves three
   * entries of the real archive unexercised — `README.txt`, `draft.md` and the DOCX, which is a
   * second ZIP with the words inside `word/document.xml` where a text search of the outer archive
   * cannot reach them. So the archive is also built once, for real, on a record that carries a
   * directive, and every entry is read with the DOCX unwrapped.
   */
  it('leaves no directive in the whole archive, every entry, with the DOCX unwrapped', async () => {
    const program = plantedCorpus().programs[0];
    const zip = await buildApplicationPacket({
      program,
      funder: makeFunder({ id: program.funderId, name: 'Planted Funder' }),
      draft: markdownToDraft('# Need statement\n\nText.', {
        title: 'Draft',
        provenanceNote: 'Generated by GrantSpotter on 2026-08-04.',
      }),
      budgetLines: [],
      generatedAtISO: '2026-08-04T00:00:00.000Z',
    });

    const entries: Record<string, string> = {};
    for (const [name, data] of Object.entries(unzipSync(zip))) {
      if (name.endsWith('.docx')) {
        for (const [inner, innerData] of Object.entries(unzipSync(data))) {
          if (inner.endsWith('.xml') || inner.endsWith('.rels')) {
            entries[`${name}!${inner}`] = strFromU8(innerData);
          }
        }
        continue;
      }
      entries[name] = strFromU8(data);
    }
    // Vacuity: the archive really was opened, and the DOCX really was unwrapped rather than
    // skipped — its words live in `draft.docx!word/document.xml`, which is why it has no plain key.
    expect(Object.keys(entries).filter((k) => !k.includes('!')).sort()).toEqual([
      'README.txt',
      'budget-worksheet.csv',
      'draft.md',
      'requirements-checklist.md',
      'source-links.md',
    ]);
    expect(Object.keys(entries)).toContain('draft.docx!word/document.xml');
    expect(entries['README.txt']).toContain(program.name);

    for (const [name, text] of Object.entries(entries)) {
      expect(directivesIn(text), `${name} carries the directive`).toEqual([]);
    }
  }, 60_000);
});

/* ------------------------------------------------------------------- the completeness guards */

/**
 * WHAT MAKES THIS FILE DIFFERENT FROM THE THREE ROUNDS BEFORE IT. Everything above proves things
 * about the surfaces that are listed. These two prove that the list is the whole list — the
 * property no round of this defect ever had, and the only one that stops a sixth surface.
 */
describe('the list of surfaces is the whole list', () => {
  it('covers every route that hands a person a document', () => {
    const source = readFileSync(join(REPO_ROOT, 'packages/server/src/api/exports.ts'), 'utf8');
    // Every mounted path on the exports router, in source order.
    const routes = [...source.matchAll(/router\.(get|post|delete)\(\s*'([^']+)'/g)].map(
      (m) => `${m[1].toUpperCase()} ${m[2]}`,
    );
    expect(routes.length, 'the route table was not parsed at all').toBeGreaterThan(8);

    /**
     * Every route classified: which surface renders it, or why it renders no prose. A route added
     * to `exports.ts` and not to this map fails here — which is the whole mechanism.
     */
    const CLASSIFIED: Readonly<Record<string, string>> = {
      'GET /exports/opportunities.csv': 'opportunities.csv',
      'GET /exports/opportunities.xlsx': 'opportunities.xlsx',
      'GET /exports/eligibility.csv': 'eligibility.csv',
      'GET /exports/eligibility.html': 'eligibility.html',
      'GET /exports/deadlines.ics': 'deadlines.ics',
      'GET /calendar/:token': 'deadlines.ics',
      // Renders no record prose: a token handle, a packet built from a request body, a draft
      // rendered from the applicant's own document, and the admin backup, which is a database
      // dump for an operator and is REQUIRED to carry storage identifiers verbatim.
      'GET /exports/ics-token': 'no record prose — reports whether a feed token exists',
      'POST /exports/ics-token': 'no record prose — mints a feed token',
      'DELETE /exports/ics-token': 'no record prose — revokes a feed token',
      'POST /exports/draft.md': "no record prose — renders the applicant's own draft",
      'POST /exports/draft.docx': "no record prose — the same draft as a Word document",
      'GET /admin/backup.json': 'a database dump for an operator; identifiers belong in it',
      'POST /admin/restore': 'no record prose — accepts a dump',
      // `buildApplicationPacket` writes six files. Three carry the record's own prose and are
      // surfaces above; the other three (`README.txt`, `draft.md`, `draft.docx`) are covered
      // whole, as real archive bytes with the nested DOCX expanded, by `the whole archive, every
      // entry, with the DOCX unwrapped` below — so no entry of this route rests on a claim.
      'POST /exports/packet.zip': 'packet/requirements-checklist.md',
    };

    const unclassified = routes.filter((r) => CLASSIFIED[r] === undefined);
    expect(
      unclassified,
      'A route on the exports router is neither covered by a surface in SURFACES nor recorded ' +
        'here as rendering no record prose. Classify it — that decision is exactly the one that ' +
        'was never made for the CSV, the XLSX or the calendar page.',
    ).toEqual([]);

    // And every surface id named above really is in SURFACES.
    const ids = new Set(SURFACES.map((s) => s.id));
    for (const [route, verdict] of Object.entries(CLASSIFIED)) {
      if (verdict.startsWith('no record prose') || verdict.startsWith('a database dump')) continue;
      expect(ids.has(verdict), `${route} names surface "${verdict}", which is not in SURFACES`).toBe(
        true,
      );
    }
  });

  /**
   * THE WEB HALF, AND THE ASSERTION THAT WOULD HAVE CAUGHT ROUNDS ONE, TWO AND FIVE.
   *
   * `deadline.note` arrives in the browser whole on two responses, because two pages have to split
   * it themselves. Every web module that touches that field must therefore run core's reader; a
   * module that names the field and not the reader is printing it raw, which is what the record
   * page did (round one), what the Inbox did twice over (round two) and what `Calendar.tsx` did
   * until this file was written.
   *
   * It is a source-level check on purpose. `web` cannot import a helper from `server` and this
   * test cannot render a React tree, so the alternative is a second detector in a second package —
   * one more copy of the decision, which is the disease rather than the cure.
   *
   * A PRINTING SITE IS A LINE, NOT A FILE. `components/AgendaList.tsx` declares the wire shape —
   * `deadlineNote: string;` inside an interface — and never renders it; flagging that would be
   * this check crying wolf on a type, and a guard that cries wolf is a guard somebody deletes. So
   * a file is only asked the question when some LINE in it puts the field inside a brace
   * expression, which is what `<p className="prep">{program.deadlineNote}</p>` is and what a
   * field declaration is not.
   */
  it('finds no web module printing a deadline note without core’s reader', () => {
    const tree = join(REPO_ROOT, 'packages/web/src');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) files.push(full);
      }
    };
    walk(tree);
    expect(files.length, 'the web tree was not walked').toBeGreaterThan(20);

    /** A line that puts the raw note inside a brace expression — i.e. renders it. */
    const PRINTS = /\{[^{}]*\b(?:deadlineNote|deadline\.note)\b[^{}]*\}/;
    const printing = files
      .map((file) => ({ file, text: readFileSync(file, 'utf8') }))
      .filter(({ text }) => text.split('\n').some((line) => PRINTS.test(line)));

    // Vacuity: if nothing in the tree prints a note any more, this check has stopped checking.
    expect(
      printing.map(({ file }) => file.slice(REPO_ROOT.length)).sort(),
      'no web module renders a deadline note at all, so the guard below proves nothing',
    ).not.toEqual([]);

    const offenders = printing
      .filter(({ text }) => !text.includes('readDeadlineNote'))
      .map(({ file }) => file.slice(REPO_ROOT.length));

    expect(
      offenders,
      'A web module reads the raw `deadline.note` / `deadlineNote` field and never calls ' +
        "`readDeadlineNote`. That field carries `RECUR n_fixed_dates tz=… dates=02-01,…` in front " +
        'of the funder\'s sentence, so whatever this module prints, it prints the directive with ' +
        'it. Import the reader from @grantspotter/core (or from lib/programWords) and print ' +
        '`prose`, with `rule` in its own row.',
    ).toEqual([]);
  });
});

/* --------------------------------------------------------------------------- the wider census */

/**
 * THE SAME DEFECT, ONE CLASS WIDER, MEASURED RATHER THAN CLAIMED.
 *
 * `RECUR` is gone from every surface above. The identifiers it travelled beside are NOT: the
 * spreadsheet a student forwards still says `ham_scholarship` under "Class", `seed_import` under
 * "Verification method" and `external_spa_portal` under "Apply via", and the packet checklist says
 * `Status: … , external_spa_portal`. `web/src/lib/programWords.ts` already holds the English for
 * three of those unions, and `lib/filterState.ts` for a fourth — but they live in `web`, the
 * server cannot import `web`, and so every server-rendered surface prints the token. That is the
 * SAME structural fault that kept the directive alive for three rounds, one abstraction up: the
 * translation lives where only one of the four surfaces can reach it.
 *
 * This is not fixed here — the fix is to move those tables to core and route six producers through
 * them, which is a change to product code across three packages and is named in the handover
 * instead. What IS done here is to stop it growing: the census below is measured, per surface, per
 * corpus, and a surface may only ever print FEWER kinds of identifier than it does today. A new
 * export starts at zero and cannot ship carrying any.
 */
const CENSUS_CEILING: Readonly<Record<string, number>> = {
  // distinct snake_case storage identifiers reaching a reader, measured 2026-08-13, worst corpus
  'opportunities.csv': 34,
  'opportunities.xlsx': 34,
  'deadlines.ics': 6,
  'eligibility.csv': 6,
  'eligibility.html': 6,
  'packet/requirements-checklist.md': 16,
  'packet/sources.md': 2,
  'packet/budget-worksheet.csv': 0,
};

describe('the storage vocabulary that still reaches a reader', () => {
  it('is no wider on any surface than it was when this was measured', async () => {
    const widest = new Map<string, number>();
    const detail: string[] = [];
    for (const corpus of corpora) {
      const vocabulary = new Set(corpus.programs.flatMap(storedIdentifiers));
      expect(vocabulary.size, `${corpus.label} stores no snake_case identifiers`).toBeGreaterThan(20);
      for (const surface of SURFACES) {
        const hits = identifiersIn(await surface.produce(corpus), vocabulary);
        if (hits.size > (widest.get(surface.id) ?? -1)) {
          widest.set(surface.id, hits.size);
          detail.push(
            `${surface.id} @ ${corpus.label}: ${String(hits.size)} — ${[...hits.keys()]
              .sort()
              .join(' ')}`,
          );
        }
      }
    }
    for (const surface of SURFACES) {
      const measured = widest.get(surface.id) ?? 0;
      expect(
        measured,
        `${surface.id} prints ${String(measured)} distinct storage identifiers, up from the ` +
          `${String(CENSUS_CEILING[surface.id])} measured on 2026-08-13. These are tokens, not ` +
          'English: a reader meeting `n_fixed_dates` under "Deadline pattern" is being shown how ' +
          'this product spells a fact, not what the fact is. Translate through the word tables — ' +
          'and if this number went UP because a surface was added, it should have started at 0.\n' +
          detail.join('\n'),
      ).toBeLessThanOrEqual(CENSUS_CEILING[surface.id]);
    }
    // The ceiling names every surface, so a new surface cannot slip past by having no entry.
    for (const surface of SURFACES) {
      expect(CENSUS_CEILING[surface.id], `${surface.id} has no census entry`).toBeDefined();
    }
  }, 180_000);
});
