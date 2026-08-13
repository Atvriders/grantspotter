/**
 * THE PROMISE, MEASURED: the count on the screen and the number of rows in the file, for the same
 * query string, over the real corpus, for every filter the browse screen has.
 *
 * Beside the export buttons the product says "Exports exactly what the filters above are showing".
 * That sentence is a claim about TWO endpoints agreeing, so it cannot be proved by testing either
 * of them alone — which is why it was false on the live site in three different ways at once while
 * every export suite in this repository was green. This file mounts `GET /api/programs` and the
 * export routes on ONE app over ONE database and asks them the same question.
 *
 * WHAT WAS MEASURED ON grant.waterburp.com BEFORE THE FIX (2026-08-13, as a signed-in member):
 *
 *   Opportunity class = Ham grant      screen 8    `.ics` 252 VEVENTs / 121 programmes
 *                                                  (byte-identical to the unfiltered feed)
 *   From 2026-09-01 / To 2026-12-31,
 *     "keep rolling and undated" ON     screen 139  CSV 117   ← the DEFAULT state of the checkbox
 *   Award amount Min = 5000             screen 17   CSV 143   ← the entire corpus
 *   Matcher verdict = Ineligible        screen 41   CSV 143   ← the entire corpus
 *
 * The three causes were different — a route that never read its query string, a boolean with no
 * spelling in the export vocabulary, and three filters the URL builder dropped on the floor — so
 * the assertions below are not three assertions. `SELECTION_PARITY` is keyed by
 * `keyof BrowseFilters`: a filter added to the browse screen does not compile until it is listed
 * here, and listing it as a filter obliges it to carry a probe that this file then measures on both
 * surfaces. That is the part that outlives this commit.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import type Database from 'better-sqlite3';
import type { Profile } from '@grantspotter/core';
import { openTestDb } from '../test/testDb.js';
import { seedTestUser } from '../test/fixtures/programs.js';
import { createFunderRepo } from '../db/repositories/funders.js';
import { createProgramRepo, withContentHash } from '../db/repositories/programs.js';
import { saveProfile } from '../api/profileStore.js';
import { reindexBrowse } from '../api/reindex.js';
import { createProgramsRouter } from '../api/programsRouter.js';
import { createExportsRouter, type ExportDeps } from '../api/exports.js';
import { errorHandler, requestIdMiddleware } from '../api/errors.js';
import type { RouterDeps, SessionUser } from '../api/deps.js';
import type { BrowseFilters } from '../api/browseTypes.js';
import { createSqliteExportDataSource } from './dataSource.js';
import { loadExportCorpus, type ExportCorpus } from './testCorpus.js';
import { DO_NOT_PUBLISH_TAG } from '../normalize/index.js';

const MEMBER: SessionUser = { id: 'u-member', email: 'member@example.com', role: 'member' };
const STRANGER: SessionUser = { id: 'u-nobody', email: 'nobody@example.com', role: 'member' };

/**
 * A licensed undergraduate, the same shape `api/programsRouter.test.ts` matches its census
 * against. It exists here for one reason: the matcher verdict is a filter on screen, and a filter
 * that cannot be exercised cannot be proved to reach the file.
 */
const STUDENT: Profile = {
  kind: 'student',
  callsign: 'W8UM',
  licenseClass: 'GENERAL',
  licensedSince: '2023-05-01',
  state: 'MI',
  degreeLevel: 'BACH',
  institution: 'Example State University',
  accredited: true,
  partTime: false,
  citizenship: 'US_CITIZEN',
  stage: 'UNDERGRAD',
} as Profile;

let corpus: ExportCorpus;
let db: Database.Database;
let app: express.Express;
/** The same app, for a signed-in user who has saved no profile at all. */
let strangerApp: express.Express;
let NOW: string;

function buildApp(user: SessionUser): express.Express {
  const routerDeps: RouterDeps = {
    db,
    now: () => NOW,
    requireAuth: (_req, _res, next) => next(),
    requireAdmin: (_req, _res, next) => next(),
    currentUser: () => user,
  };
  const exportDeps: ExportDeps = {
    data: createSqliteExportDataSource(db),
    requireAuth: (_req, _res, next) => next(),
    requireAdmin: (_req, _res, next) => next(),
    now: () => NOW,
    userIdOf: () => user.id,
    publicBaseUrl: () => 'http://127.0.0.1:3030',
  };
  const built = express();
  built.use(requestIdMiddleware());
  built.use(express.json());
  built.use('/api/programs', createProgramsRouter(routerDeps));
  built.use('/api', createExportsRouter(exportDeps));
  built.use(errorHandler({ logger: () => undefined }));
  return built;
}

beforeAll(async () => {
  corpus = await loadExportCorpus();
  NOW = corpus.now;
  db = openTestDb();

  const funders = createFunderRepo(db);
  // `loadExportCorpus` builds funder rows for the publishable population only; `programs.funder_id`
  // is a real foreign key, so the suppressed records need theirs too or nothing seeds at all.
  const named = new Map(corpus.funders.map((f) => [f.id, f]));
  for (const program of [...corpus.programs, ...corpus.suppressedPrograms]) {
    funders.upsert(
      named.get(program.funderId) ?? {
        id: program.funderId,
        name: `Funder ${program.funderId}`,
        homepage: 'https://example.com/',
      },
    );
  }
  const programs = createProgramRepo(db);
  // BOTH populations. The suppressed 553 are stored in production and this file must not be able
  // to pass because they were absent from the database it ran against.
  for (const program of [...corpus.programs, ...corpus.suppressedPrograms]) {
    programs.upsert(withContentHash(program));
  }
  seedTestUser(db, 'u-member');
  seedTestUser(db, 'u-nobody');
  saveProfile(db, 'u-member', 'student', STUDENT, NOW);
  reindexBrowse(db, NOW);

  app = buildApp(MEMBER);
  strangerApp = buildApp(STRANGER);
}, 60_000);

afterAll(() => {
  db.close();
});

/** What the screen says: the unpaginated match count `Browse` prints as "N programmes match". */
async function onScreen(query: string, target = app): Promise<number> {
  const res = await request(target).get(`/api/programs?${query}&pageSize=1`);
  expect(res.status, query).toBe(200);
  return (res.body as { total: number }).total;
}

/** RFC 4180 enough for counting: quoted fields may contain the row separator. */
function csvDataRows(body: string): number {
  let rows = 0;
  let quoted = false;
  for (const ch of body) {
    if (ch === '"') quoted = !quoted;
    else if (ch === '\n' && !quoted) rows += 1;
  }
  return rows - 1; // the header
}

async function inCsv(query: string, target = app): Promise<number> {
  const res = await request(target).get(`/api/exports/opportunities.csv?${query}`);
  expect(res.status, query).toBe(200);
  return csvDataRows(res.text);
}

/**
 * The programme ids a calendar actually covers, read back out of its UIDs.
 *
 * UNFOLDED FIRST. RFC 5545 wraps a long line and continues it after a space, and this corpus's ids
 * are long enough that every one of them wraps: read without unfolding, each UID comes back as its
 * own first seventy characters, no id matches any id from the CSV, and the comparison below
 * reports a hundred phantom leaks. Which it did.
 */
async function inCalendar(query: string, target = app): Promise<Set<string>> {
  const res = await request(target).get(`/api/exports/deadlines.ics?${query}`);
  expect(res.status, query).toBe(200);
  const unfolded = res.text.replace(/\r\n[ \t]/g, '');
  const ids = [...unfolded.matchAll(/^UID:([^:\r\n]+)/gm)].map((m) => m[1]);
  return new Set(ids);
}

/**
 * The `id` column of every data row, read back out of the bytes.
 *
 * Splitting on the row separator does NOT work here and the first version of this helper did:
 * `summary` is quoted prose and carries embedded newlines, so a line-wise reader hands back the
 * middle of a sentence as an id and every real id then reads as "missing". The failure was silent
 * in the useful direction — a calendar containing a programme the CSV also contains looked like a
 * leak — which is the same class of defect this file exists to catch, one layer down.
 */
async function csvIds(query: string, target = app): Promise<Set<string>> {
  const res = await request(target).get(`/api/exports/opportunities.csv?${query}`);
  const ids: string[] = [];
  let field = '';
  let column = 0;
  let quoted = false;
  const endField = (): void => {
    if (column === 0) ids.push(field);
    field = '';
  };
  const text = res.text;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      endField();
      column += 1;
    } else if (ch === '\n') {
      endField();
      column = 0;
    } else if (ch !== '\r') field += ch;
  }
  if (field.length > 0) endField();
  // Drop the header's own `id` cell, and the UTF-8 BOM that precedes it.
  return new Set(ids.slice(1));
}

/**
 * EVERY FILTER THE BROWSE SCREEN HAS, CLASSIFIED, WITH THE PROBE THAT MEASURES IT.
 *
 * `Record<keyof BrowseFilters, …>`, so this file stops compiling the moment `BrowseFilters` grows
 * a key. That is the enforcement the three defects needed and did not have: each of them was a
 * filter that existed on screen and reached no export, and nothing anywhere failed. A new filter
 * now has two legal fates — a probe that is measured against both surfaces below, or a written
 * reason why it selects nothing — and neither of them is silence.
 *
 * A probe must NARROW the corpus (`min` and `max` bracket the count it is expected to produce, so
 * a probe that stops biting — because the corpus moved, or because the filter quietly stopped
 * working — fails here rather than passing vacuously against an unfiltered 150).
 */
type Probe =
  | { selects: true; query: string; min: number; max: number }
  | { selects: false; why: string };

const SELECTION_PARITY: Record<keyof BrowseFilters, Probe> = {
  klass: { selects: true, query: 'klass=ham_grant', min: 1, max: 60 },
  entity: { selects: true, query: 'entity=club_501c3', min: 1, max: 149 },
  instrument: { selects: true, query: 'instrument=cash_fixed', min: 1, max: 149 },
  status: { selects: true, query: 'status=open', min: 1, max: 149 },
  verdict: { selects: true, query: 'verdict=ineligible', min: 1, max: 149 },
  deadlineFrom: { selects: true, query: 'deadlineFrom=2026-09-01', min: 1, max: 149 },
  deadlineTo: { selects: true, query: 'deadlineTo=2026-12-31', min: 1, max: 149 },
  // The DEFAULT is `true`, so the probe is the un-default: the corpus's rolling and undated
  // programmes, dropped from a window that would otherwise keep them. This is defect 2 in one
  // line — the export had no spelling for this key at all, and so always behaved as `false`.
  includeRolling: {
    selects: true,
    query: 'deadlineFrom=2026-09-01&deadlineTo=2026-12-31&includeRolling=false',
    min: 1,
    max: 149,
  },
  amountMin: { selects: true, query: 'amountMin=5000', min: 1, max: 149 },
  amountMax: { selects: true, query: 'amountMax=1000', min: 1, max: 149 },
  q: { selects: true, query: 'q=scholarship', min: 1, max: 149 },
  sort: {
    selects: false,
    why:
      'Ordering, not selection: it changes which row is first, never which rows there are. The ' +
      'export carries it anyway — `queryProgramIds` orders by it — so the file arrives in the ' +
      'order the screen was read in.',
  },
  page: {
    selects: false,
    why:
      'A property of the screen. An export is every match: shipping "page 1 of 3" would be 50 of ' +
      '139 rows to somebody who never asked for a page.',
  },
  pageSize: { selects: false, why: 'The same, from the other end. The export is unpaginated.' },
};

describe('the export and the screen answer the same query', () => {
  it('has a probe for every filter the browse screen can express', () => {
    // The compiler enforces the keys; this enforces that the classification is not empty prose.
    for (const [key, probe] of Object.entries(SELECTION_PARITY)) {
      if (probe.selects) expect(probe.query.length, key).toBeGreaterThan(0);
      else expect(probe.why.length, key).toBeGreaterThan(40);
    }
  });

  it('agrees on the unfiltered corpus, which is the number every probe is measured against', async () => {
    const total = await onScreen('');
    expect(total).toBe(corpus.programs.length);
    expect(await inCsv('')).toBe(total);
  });

  for (const [key, probe] of Object.entries(SELECTION_PARITY)) {
    if (!probe.selects) continue;
    it(`carries "${key}" into the file, row for row`, async () => {
      const unfiltered = await onScreen('');
      const screen = await onScreen(probe.query);
      // The probe has to bite, or the equality below is a statement about two unfiltered lists.
      expect(screen, `${key}: the probe no longer narrows the corpus`).toBeGreaterThanOrEqual(
        probe.min,
      );
      expect(screen, `${key}: the probe no longer narrows the corpus`).toBeLessThanOrEqual(
        Math.min(probe.max, unfiltered - 1),
      );
      expect(await inCsv(probe.query), `${key}: CSV`).toBe(screen);
    });
  }

  /**
   * ROW ORDER, because the URL builder claims it. `sort` is carried into the export even though it
   * selects nothing, on the grounds that `queryProgramIds` orders by it and the file therefore
   * arrives in the order the screen was read in. That is a claim about two endpoints agreeing, so
   * it is measured here rather than asserted in a comment.
   */
  it('writes the rows in the order the screen listed them', async () => {
    for (const sort of ['name', 'amount_desc', 'deadline']) {
      const res = await request(app).get(`/api/programs?sort=${sort}&pageSize=200`);
      const onePage = (res.body as { rows: Array<{ program: { id: string } }>; total: number });
      const screenOrder = onePage.rows.map((row) => row.program.id);
      expect(screenOrder.length, sort).toBeGreaterThan(100);
      const fileOrder = [...(await csvIds(`sort=${sort}`))];
      expect(fileOrder.slice(0, screenOrder.length), sort).toEqual(screenOrder);
    }
  }, 30_000);

  /**
   * The calendar cannot be counted in rows: a programme with no dated cycle has no event, and one
   * with four windows has four. What it CAN be held to is the set — every programme it mentions is
   * a programme the screen was showing, and nothing else gets in.
   */
  it('never puts a programme in the calendar that the filter excluded', async () => {
    for (const probe of Object.values(SELECTION_PARITY)) {
      if (!probe.selects) continue;
      const rows = await csvIds(probe.query);
      const calendar = await inCalendar(probe.query);
      const extra = [...calendar].filter((id) => !rows.has(id));
      expect(extra, probe.query).toEqual([]);
      expect(calendar.size, probe.query).toBeGreaterThan(0);
    }
    // One calendar and one CSV per probe over the whole corpus; the default 5s is not a claim
    // about correctness and this loop is the slowest honest way to make the claim it makes.
  }, 60_000);
});

/**
 * THE THREE DEFECTS, EACH IN THE STATE IT WAS MEASURED IN. The generic parity above would fail if
 * any of them came back, but it would fail as "klass: CSV" — a name that says nothing about what
 * a user lost. These say it.
 */
describe('the three ways the files used to break the sentence', () => {
  it('1. the .ics honours the class filter instead of shipping the whole calendar', async () => {
    const filtered = await inCalendar('klass=ham_grant');
    const everything = await inCalendar('');
    expect(filtered.size).toBeGreaterThan(0);
    // The measured failure: these two sets were identical, 121 programmes each, beside a screen
    // reading 8.
    expect(filtered.size).toBeLessThan(everything.size);
    expect([...filtered].every((id) => everything.has(id))).toBe(true);
    const screen = await onScreen('klass=ham_grant');
    expect(await inCsv('klass=ham_grant')).toBe(screen);
  });

  it('2. keeps rolling and undated programmes in a windowed export, in the checkbox’s DEFAULT state', async () => {
    const query = 'deadlineFrom=2026-09-01&deadlineTo=2026-12-31';
    const kept = await onScreen(query);
    const dropped = await onScreen(`${query}&includeRolling=false`);
    // The state a user reaches without touching anything: the checkbox is CHECKED, and the rows
    // it keeps are exactly the ones the export used to lose.
    expect(kept).toBeGreaterThan(dropped);
    expect(await inCsv(query)).toBe(kept);
    expect(await inCsv(`${query}&includeRolling=false`)).toBe(dropped);
  });

  it('3. carries the award-amount filter, which used not to reach the URL at all', async () => {
    const screen = await onScreen('amountMin=5000');
    expect(screen).toBeLessThan(corpus.programs.length);
    expect(await inCsv('amountMin=5000')).toBe(screen);
  });
});

/**
 * THE VERDICT FILTER IS THE ONE THAT COSTS MONEY TO GET WRONG, and the one an export has to run
 * the matcher to honour. It is also the only filter whose answer depends on WHO is asking, which
 * is why both directions are pinned: the right rows for a user who has a profile, and NO rows —
 * never the whole corpus — for one who does not.
 */
describe('the matcher verdict', () => {
  it('selects the same programmes in the file as on screen', async () => {
    for (const kind of ['eligible', 'ineligible', 'unknown']) {
      const screen = await onScreen(`verdict=${kind}`);
      expect(await inCsv(`verdict=${kind}`), kind).toBe(screen);
    }
  });

  it('exports nothing for a user with no profile, rather than the whole corpus', async () => {
    expect(await onScreen('verdict=eligible', strangerApp)).toBe(0);
    expect(await inCsv('verdict=eligible', strangerApp)).toBe(0);
    expect((await inCalendar('verdict=eligible', strangerApp)).size).toBe(0);
    // And with no verdict asked for, that same user gets the whole publishable corpus: the empty
    // answer above is the verdict filter, not a broken session.
    expect(await inCsv('', strangerApp)).toBe(corpus.programs.length);
  });

  it('is computed against the profile the screen is showing verdicts from', async () => {
    // A user holding BOTH profiles: `listForUser(...)[0]` is `ORDER BY kind`, which is the
    // organisation, while the browse screen uses `PROFILE_KIND_PRIORITY`, which is the student.
    // The export used to take the first and report it under the second's heading.
    saveProfile(
      db,
      'u-member',
      'organization',
      { kind: 'organization', entity: 'club_501c3', orgName: 'Example Radio Club', state: 'MI' },
      NOW,
    );
    try {
      for (const kind of ['eligible', 'ineligible', 'unknown']) {
        expect(await inCsv(`verdict=${kind}`), kind).toBe(await onScreen(`verdict=${kind}`));
      }
    } finally {
      db.prepare("DELETE FROM profiles WHERE user_id = 'u-member' AND kind = 'organization'").run();
    }
  });
});

/**
 * A URL SOMEBODY BOOKMARKED. Every export URL in existence was minted by the build that shipped
 * the defect, in a vocabulary this codebase no longer speaks. Dropping the spellings would not
 * break those links — it would silently WIDEN them to the whole corpus, which is the same harm in
 * the direction nobody notices.
 */
describe('the retired export spellings', () => {
  it('still mean what they meant, mapped onto the browse keys', async () => {
    expect(await inCsv('closesAfter=2026-09-01&closesBefore=2026-12-31')).toBe(
      await onScreen('deadlineFrom=2026-09-01&deadlineTo=2026-12-31'),
    );
    expect(await inCsv('applicantEntities=club_501c3')).toBe(await onScreen('entity=club_501c3'));
  });

  it('never override the browse key when both are present', async () => {
    const both = 'deadlineFrom=2026-09-01&closesAfter=2000-01-01';
    expect(await inCsv(both)).toBe(await onScreen('deadlineFrom=2026-09-01'));
  });
});

/**
 * THE GATE, ON THE PATH THE SELECTION NOW TAKES. `program_search` is a cache: a record
 * reclassified `do_not_publish` after the last reindex still has a projection row, and that row is
 * what `queryProgramIds` reads. This plants exactly that state — reindex, then tag — and proves
 * the belt inside `selectExportPrograms` catches what the table hands it.
 */
describe('a suppressed record with a stale projection row', () => {
  it('is refused by every export, though the browse projection still lists it', async () => {
    const victim = corpus.programs[0];
    const programs = createProgramRepo(db);
    programs.upsert(withContentHash({ ...victim, tags: [...victim.tags, DO_NOT_PUBLISH_TAG] }));
    try {
      const stale = db
        .prepare('SELECT COUNT(*) AS n FROM program_search WHERE program_id = ?')
        .get(victim.id) as { n: number };
      expect(stale.n, 'the hazard is only real while the projection row survives').toBe(1);

      expect(await csvIds('')).not.toContain(victim.id);
      expect(await inCsv('')).toBe(corpus.programs.length - 1);
      expect([...(await inCalendar(''))]).not.toContain(victim.id);
    } finally {
      programs.upsert(withContentHash(victim));
    }
  });
});
