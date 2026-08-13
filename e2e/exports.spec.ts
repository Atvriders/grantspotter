/**
 * THE PROMISE, READ OFF THE SCREEN AND OUT OF THE FILE THAT ACTUALLY LANDED ON DISK.
 *
 * Above the export buttons the product says, in so many words:
 *
 *   "Exports exactly what the filters above are showing — every match, not just the page on
 *    screen"
 *
 * On 2026-08-13 that sentence was false on grant.waterburp.com in three directions at once, and
 * 5,700 tests were green while it was. The reason is visible in what those tests each looked at:
 *
 *   - `exports/filter.test.ts` proved the export filter filtered.
 *   - `api/exports.test.ts` proved the routes served a CSV, an XLSX and a calendar.
 *   - `web/api/exports.test.ts` proved the URL builder built a URL.
 *   - `e2e/flow.spec.ts` downloaded a real `.ics` and asserted it began `BEGIN:VCALENDAR` and
 *     contained a `VEVENT` — i.e. that the file was a calendar. IT WAS A CALENDAR. It was the
 *     WHOLE calendar, 252 events for 121 programmes, downloaded from a screen showing 8.
 *
 * Every layer was proved in isolation and the composition was proved nowhere, so a defect living
 * in the JOINS — a route that never read `req.query`, a checkbox with no spelling in the export
 * vocabulary, three filters the URL builder dropped — was invisible to all of them. The one thing
 * nobody did was set a filter, press the button, open the file and count.
 *
 * WHAT THIS FILE DOES THAT THE OTHERS CANNOT. `exports/parityWithBrowse.test.ts` closes most of
 * this from the server side, and is the stronger test of the two for selection: it mounts both
 * routers over one database and sweeps every `keyof BrowseFilters`. What it cannot reach is the
 * half of the chain that lives in the browser — the filter state the SPA holds, the query string
 * `browseFiltersToExportQuery` puts in an `href`, the anchor the user clicks, and the bytes the
 * browser saves. Two of the three live defects were in that half. So this spec asserts the whole
 * chain end to end, in the units a student experiences it in:
 *
 *   the number of programmes the screen states  ===  the number of rows in the downloaded file
 *   the set of programmes the screen lists      ===  the set of ids in the downloaded file
 *
 * BOTH SIDES ARE READ FROM THE PRODUCT. The expected value is never computed by this file — it is
 * scraped out of the rendered page, and the actual value is parsed out of the saved bytes. There
 * is no third place holding a number that could be edited to make a disagreement go away, which is
 * the property that makes this fail when the product is WRONG rather than when it CHANGES.
 * Rewording the export note, adding a column, renaming a filter: none of them touch this file.
 *
 * ROW ORDER IS NOT ASSERTED HERE, ON PURPOSE. The screen's list is read across the pager — three
 * separate LIMIT/OFFSET queries — while the file is one. Where the sort has ties those two can
 * disagree without either being wrong, and an assertion that fails on a tie is an assertion that
 * gets deleted. `parityWithBrowse.test.ts` owns order, against a single unpaged read where the
 * claim is well-defined.
 *
 * XLSX IS INCLUDED BECAUSE NOTHING ELSE COUNTS ITS ROWS. `parityWithBrowse` measures the CSV and
 * the calendar; `xlsx.test.ts` proves the workbook is a workbook with the right sheets. The
 * sentence names all three formats, and the second filter vocabulary that dropped rows from the
 * CSV was the same code path the XLSX went through. It is read with `exceljs`, already this
 * server's own dependency — no new one is added.
 */
import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { expect, test, type Page } from '@playwright/test';
import { MEMBER_EMAIL, MEMBER_PASSWORD } from './helpers.js';
import { installRenderedHoleSweep } from './renderedHoles.js';

installRenderedHoleSweep();

const SPA_PENDING = 'The SPA fallback is not mounted; see the header of e2e/flow.spec.ts.';

async function openApp(page: Page): Promise<void> {
  const response = await page.goto('/');
  const body = (await response?.text()) ?? '';
  test.skip(!/^\s*<!doctype html/i.test(body), SPA_PENDING);
}

async function signIn(page: Page): Promise<void> {
  await openApp(page);
  await page.getByLabel('Email').fill(MEMBER_EMAIL);
  await page.getByLabel('Password').fill(MEMBER_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
}

/**
 * THE BROWSE SCREEN LIVES AT `/`, AND THIS SPEC LEARNED THAT THE HARD WAY.
 *
 * Its first draft navigated to `/browse?…`, which is an ALIAS route, and the alias was dropping the
 * query string — so all four scenarios were driving the UNFILTERED catalogue, comparing it against
 * an unfiltered file, and passing. A vacuous green: the assertions were real and the state they ran
 * against was not the one they named. The alias is fixed (`App.tsx`'s `BrowseAlias`) and the
 * regression is held below, but the lesson is the reason this helper exists rather than a literal
 * at five call sites: a scenario must be reached by the address the product actually canonicalises.
 *
 * Every scenario also asserts it selected FEWER programmes than the whole corpus, which is what
 * would have caught the vacuum on the first run instead of the third.
 */
function browseUrl(query: string): string {
  return query === '' ? '/' : `/?${query}`;
}

// ------------------------------------------------------------------ reading the file that landed

/**
 * RFC 4180, properly, and the reason it is not three lines of `split`.
 *
 * `summary` is quoted prose: it carries commas, doubled quotes and EMBEDDED NEWLINES. A line-wise
 * reader hands back the middle of a funder's sentence as though it were a programme id, and every
 * real id then reads as "missing from the file" — a failure that points at the product while the
 * fault is in the test. `parityWithBrowse.test.ts` records having made exactly that mistake.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') {
        field += ch;
        continue;
      }
      if (text[i + 1] === '"') {
        field += '"';
        i += 1;
        continue;
      }
      quoted = false;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (ch === '\r') continue;
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

/**
 * The `id` column of every data row. `id` is the first of `EXPORT_FIELDS`, asserted here.
 *
 * THE BOM IS ASSERTED, NOT SWALLOWED, and this spec found it by tripping over it. `csv.ts` writes
 * a UTF-8 BOM ahead of the header because Excel on Windows reads a BOM-less UTF-8 file in the
 * system code page, which turns a funder's `ARDC’s` into mojibake. `csv.test.ts` proves the
 * BUILDER emits it. Nothing proved it survived the download — the route's content type, the
 * encoding it chose, and the bytes the browser saved are three more places it could have been lost
 * between that unit test and a student's spreadsheet. So the first assertion here is that the file
 * on disk still starts with it, and only then is it stripped.
 */
const CSV_UTF8_BOM = '﻿';

function csvIds(text: string): string[] {
  expect(
    text.startsWith(CSV_UTF8_BOM),
    'the saved CSV has lost its UTF-8 BOM, so Excel on Windows will read every accented ' +
      'character in it in the system code page',
  ).toBe(true);
  const rows = parseCsv(text.slice(CSV_UTF8_BOM.length));
  const header = rows[0] ?? [];
  expect(
    header[0],
    'The CSV id column moved. This spec reads column 0 of every row as the programme id.',
  ).toBe('id');
  return rows.slice(1).map((r) => r[0] ?? '');
}

/**
 * The programme ids a calendar covers.
 *
 * A UID is `${program.id}:${closesAt}@grantspotter` (see `expandCycles` in core's `deadline.ts`),
 * so the id is everything up to the first colon — and the line must be UNFOLDED first, because
 * RFC 5545 wraps at 75 octets and continues after a space, which every id in this corpus is long
 * enough to trigger.
 */
function icsProgramIds(text: string): string[] {
  const unfolded = text.replace(/\r\n[ \t]/g, '');
  return [...unfolded.matchAll(/^UID:([^:\r\n]+)/gm)].map((m) => m[1] ?? '');
}

/**
 * The id column of the workbook's Opportunities sheet.
 *
 * The header row carries `EXPORT_FIELD_LABELS`, not the field keys, so it is the POSITION that is
 * relied on here — the same position `csvIds` proves is `id` in the CSV, from the same
 * `EXPORT_FIELDS` order both formats are built from.
 */
async function xlsxIds(path: string): Promise<string[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  const sheet = workbook.getWorksheet('Opportunities');
  expect(sheet, 'the workbook has no Opportunities sheet').toBeDefined();
  const ids: string[] = [];
  sheet?.eachRow((row, number) => {
    if (number === 1) return; // the header
    ids.push(String(row.getCell(1).value ?? ''));
  });
  return ids;
}

// ------------------------------------------------------------------- reading what the screen says

/**
 * Press an export link and read back the bytes the browser saved.
 *
 * `download.path()` is the file on disk — not a response body this test fetched itself with its
 * own headers and its own cookies. That distinction is the whole point of doing this in a browser:
 * the URL under test is the one the product put in the `href`.
 */
async function downloadText(page: Page, name: RegExp | string): Promise<string> {
  return readFileSync(await downloadPath(page, name), 'utf8');
}

async function downloadPath(page: Page, name: RegExp | string): Promise<string> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name }).click(),
  ]);
  const saved = await download.path();
  expect(saved, `no file was saved for ${String(name)}`).toBeTruthy();
  return saved;
}

/**
 * WAIT FOR THE FILTER TO HAVE LANDED, AND WHY THIS IS NOT COSMETIC FLAKE-PROOFING.
 *
 * `ExportMenu` renders from the SPA's filter state, so between `goto('/?klass=…')` and React
 * re-rendering there is a window in which the export anchor still carries the PREVIOUS query — and
 * `locator.evaluateAll` does not auto-wait, so a read in that window sees the old href and the old
 * rows. The first run of this spec did exactly that and reported a filtered calendar covering 122
 * programmes: a perfect reproduction of the live defect, produced entirely by the test.
 *
 * That is the dangerous direction for a race to fail in — it manufactures the finding the file
 * exists to detect. So every read below is gated on the results for the CURRENT filter having
 * actually rendered.
 *
 * A scenario that matches nothing would time out here rather than pass. That is deliberate: every
 * scenario in this file asserts it selected something, because a claim about an empty view and an
 * empty file is a claim about nothing.
 */
async function awaitResults(page: Page): Promise<void> {
  await expect(page.getByRole('link', { name: 'CSV' })).toBeVisible();
  await expect(page.locator('.browse-results a[href^="/o/"]').first()).toBeVisible();
}

/**
 * Every `/api/programs` question the screen has asked, newest last.
 *
 * The export button is asserted against THE REQUEST THE SCREEN JUST MADE rather than against the
 * address bar, and the difference is not pedantry. `filtersToSearchParams` emits only what differs
 * from the default — `includeRolling` is written when it is FALSE and omitted when true — so a
 * hand-typed `?includeRolling=true` and a canonical `?` are the same filter with different
 * spellings. Comparing the button to the address bar flags that as a mismatch and would push
 * whoever hit it towards weakening the assertion. Comparing it to the browse request compares two
 * serialisations of one `UiFilters` object, which is exactly the claim
 * `browseFiltersToExportQuery` makes: the same request, minus `page`.
 */
function trackBrowseRequests(page: Page): () => URLSearchParams {
  const seen: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/programs') seen.push(url.search);
  });
  return () => {
    expect(seen.length, 'the browse screen never asked /api/programs anything').toBeGreaterThan(0);
    return new URLSearchParams(seen[seen.length - 1] ?? '');
  };
}

/**
 * THE HREF IS THE PROMISE, SO THE HREF IS ASSERTED.
 *
 * Three filters reached the live export links as nothing at all — `amountMin`, `amountMax` and
 * `verdict` — and the visible symptom was a BARE URL under a heading that said "exports exactly
 * what the filters above are showing".
 *
 * Neither side is written down here. A filter added to the browse screen is covered the day it
 * reaches the request, and no edit to this file can be required to keep it true.
 */
async function expectExportCarriesTheView(
  page: Page,
  name: string,
  lastBrowseQuery: () => URLSearchParams,
): Promise<void> {
  const href = await page.getByRole('link', { name }).getAttribute('href');
  expect(href, `the ${name} link has no href`).not.toBeNull();

  const asked = lastBrowseQuery();
  // An export is every match; a page is a property of the screen. This is the ONE documented
  // difference between the two requests, and `web/src/api/exports.test.ts` holds that list closed.
  asked.delete('page');
  const inLink = new URL(href ?? '', page.url()).searchParams;

  const flatten = (params: URLSearchParams): string[] =>
    [...params.entries()].map(([k, v]) => `${k}=${v}`).sort();

  expect(
    flatten(inLink),
    `the ${name} link does not ask the question the screen asked. The screen requested ` +
      `"${asked.toString()}" and the button holds "${inLink.toString()}".`,
  ).toEqual(flatten(asked));
}

/**
 * Every programme id the screen is listing, walked across the pager.
 *
 * An export is every match and a page is fifty, so a set read off page one alone would agree with
 * a file that had been truncated to page one — which is a thing the export note explicitly denies
 * ("every match, not just the page on screen"). Walking is what lets this spec hold that clause.
 */
async function idsOnScreen(page: Page): Promise<string[]> {
  const ids: string[] = [];
  for (;;) {
    await awaitResults(page);
    const hrefs = await page
      .locator('.browse-results a[href^="/o/"]')
      // `lib` here is ES2022 with no DOM (see tsconfig.base.json), so the browser-side callback
      // states the one method it uses rather than naming a DOM interface that does not exist in
      // this project's type world. `e2e/renderedHoles.ts` declares its own shapes for the same
      // reason.
      .evaluateAll((nodes: Array<{ getAttribute(name: string): string | null }>) =>
        nodes.map((n) => n.getAttribute('href') ?? ''),
      );
    const before = ids.length;
    for (const href of hrefs) {
      const id = href.slice('/o/'.length);
      if (id !== '' && !ids.includes(id)) ids.push(id);
    }
    const next = page.getByRole('button', { name: 'Next page' });
    if ((await next.count()) === 0 || (await next.isDisabled())) return ids;
    expect(ids.length, 'a page of the pager added no programme this walk had not seen').toBeGreaterThan(before);
    await next.click();
    await expect(page.locator('.browse-results a[href^="/o/"]').first()).toBeVisible();
  }
}

/**
 * The count the screen STATES, as opposed to the rows it happens to be showing.
 *
 * The pager prints "N programmes match" and is the sentence a reader believes. It is rendered only
 * when there is more than one page, so a single-page view is held to the number of rows it lists —
 * which is the same claim, made by the list itself.
 */
async function statedOnScreen(page: Page, listed: number): Promise<number> {
  const pager = page.getByRole('navigation', { name: 'Pagination' });
  if ((await pager.count()) === 0) return listed;
  const text = (await pager.innerText()).replace(/\s+/g, ' ');
  const match = /(\d+) programmes match/.exec(text);
  expect(match, `the pager said something this spec cannot read: "${text}"`).not.toBeNull();
  return Number(match?.[1]);
}

/**
 * How many programmes the corpus holds with nothing filtered, so a scenario can prove it BIT.
 *
 * This is the assertion the first draft of this file lacked, and lacking it is how four scenarios
 * ran green against the unfiltered catalogue for three runs. A filter that selects everything
 * cannot distinguish a working export from one that ignores its query.
 */
async function unfilteredTotal(page: Page): Promise<number> {
  const res = await page.request.get('/api/programs?pageSize=1');
  expect(res.status()).toBe(200);
  return ((await res.json()) as { total: number }).total;
}

/** Sign in, land on a filtered browse screen, and read what it says it is showing. */
async function view(page: Page, query: string): Promise<{ ids: string[]; stated: number }> {
  await page.goto(browseUrl(query));
  const ids = await idsOnScreen(page);
  const stated = await statedOnScreen(page, ids.length);
  expect(
    ids.length,
    'the pager states a total that its own pages do not add up to',
  ).toBe(stated);
  return { ids, stated };
}

// ---------------------------------------------------------------------------------- the scenarios

/**
 * THE FILTERS, AND WHY THESE ONES.
 *
 * The first three are the three states measured false on the live site, each of which broke for a
 * DIFFERENT reason, so no single fix can make all three pass by accident. The fourth is the
 * unfiltered view: without it, an export that returned NOTHING would satisfy every other case
 * here, since an empty file trivially "contains no programme the screen was not showing".
 *
 * The query strings are the browse screen's own vocabulary — this is what `filtersToSearchParams`
 * puts in the address bar — so navigating to one leaves the SPA in the state a user reaches by
 * pressing the controls. The last test in this file drives the controls themselves, which is the
 * only way to prove those two are the same state.
 */
const SCENARIOS: ReadonlyArray<{ name: string; query: string; note: string }> = [
  {
    name: 'a class filter',
    query: 'klass=ham_grant',
    note: 'Live: 8 programmes on screen, a calendar carrying 121 — the .ics never read its query.',
  },
  {
    name: 'a deadline window with rolling programmes kept',
    query: 'deadlineFrom=2026-09-01&deadlineTo=2026-12-31&includeRolling=true',
    note: 'Live: 139 on screen, 117 in the CSV — includeRolling had no spelling in the export.',
  },
  {
    name: 'an award-amount floor',
    query: 'amountMin=5000',
    note: 'Live: 17 on screen, 143 in the CSV — amountMin never reached the URL at all.',
  },
  {
    name: 'no filter at all',
    query: '',
    note: 'The control: an export that shipped nothing would pass every case above.',
  },
];

test.describe('the file is the view', () => {
  for (const scenario of SCENARIOS) {
    test(`${scenario.name}: the CSV, the XLSX and the calendar all agree with the screen`, async ({
      page,
    }) => {
      const lastBrowseQuery = trackBrowseRequests(page);
      await signIn(page);
      const { ids: screenIds, stated } = await view(page, scenario.query);

      // A scenario that matches nothing proves nothing: every claim below would hold vacuously.
      expect(stated, `${scenario.name} selected nothing — ${scenario.note}`).toBeGreaterThan(0);

      /*
       * AND A SCENARIO THAT MATCHES EVERYTHING PROVES NOTHING EITHER. An export that ignored its
       * query outright agrees perfectly with a screen that is showing the whole corpus, which is
       * exactly how the first draft of this file passed while driving the unfiltered catalogue.
       */
      if (scenario.query !== '') {
        expect(
          stated,
          `${scenario.name} selected the entire corpus, so it cannot tell an honoured filter ` +
            'from an ignored one. Pick a filter that narrows this corpus.',
        ).toBeLessThan(await unfilteredTotal(page));
      }

      // Back to page one, so the walk's last `?page=N` is not what the buttons are read from.
      await page.goto(browseUrl(scenario.query));
      await awaitResults(page);
      for (const button of ['CSV', 'XLSX', 'Deadlines (.ics)']) {
        await expectExportCarriesTheView(page, button, lastBrowseQuery);
      }

      const csv = csvIds(await downloadText(page, 'CSV'));

      /*
       * THE ASSERTION THE OLD .ics TEST DID NOT MAKE. Not "the file is a CSV" — the file is THIS
       * CSV: the same programmes, and the same number of them.
       */
      expect(
        csv.length,
        `${scenario.name}: the screen states ${String(stated)} programmes and the CSV has ` +
          `${String(csv.length)} rows. ${scenario.note}`,
      ).toBe(stated);
      expect([...csv].sort()).toEqual([...screenIds].sort());

      const workbook = await xlsxIds(await downloadPath(page, 'XLSX'));
      expect(
        workbook.length,
        `${scenario.name}: the screen states ${String(stated)} programmes and the XLSX has ` +
          `${String(workbook.length)} rows.`,
      ).toBe(stated);
      expect([...workbook].sort()).toEqual([...screenIds].sort());

      /*
       * The calendar is a SUBSET and cannot be counted in rows: a rolling programme has no date and
       * so no event, and a programme with four windows has four. What it can be held to is that
       * every programme it mentions is one the screen was showing.
       */
      const calendar = new Set(icsProgramIds(await downloadText(page, /Deadlines \(\.ics\)/)));
      const shown = new Set(screenIds);
      expect(
        [...calendar].filter((id) => !shown.has(id)),
        `${scenario.name}: the calendar carries programmes the screen was not showing. ` +
          scenario.note,
      ).toEqual([]);
    });
  }
});

/**
 * THE DEFECT IN ITS OWN CLOTHES.
 *
 * The parity above would fail if the `.ics` went back to ignoring its query — but it would fail as
 * "a class filter: the calendar carries programmes the screen was not showing", which does not say
 * what a user lost. This says it: a filtered calendar that covers exactly what the unfiltered one
 * covers is the live defect precisely, and it is worth one assertion that can mean nothing else.
 */
test('a filtered calendar is not the whole calendar with a query string on it', async ({ page }) => {
  const lastBrowseQuery = trackBrowseRequests(page);
  await signIn(page);

  await page.goto(browseUrl(''));
  await awaitResults(page);
  const everything = new Set(icsProgramIds(await downloadText(page, /Deadlines \(\.ics\)/)));

  await page.goto(browseUrl('klass=ham_grant'));
  await awaitResults(page);
  await expectExportCarriesTheView(page, 'Deadlines (.ics)', lastBrowseQuery);
  const some = new Set(icsProgramIds(await downloadText(page, /Deadlines \(\.ics\)/)));

  // Both are real calendars, so "they differ" cannot be satisfied by one of them being empty.
  expect(some.size, 'the filtered calendar is empty; it cannot show a filter was honoured').toBeGreaterThan(0);
  expect(everything.size, 'the unfiltered calendar is empty; the corpus has no dated programmes').toBeGreaterThan(0);

  expect(
    some.size,
    'the class filter produced a calendar covering as many programmes as no filter at all',
  ).toBeLessThan(everything.size);
  expect([...some].filter((id) => !everything.has(id))).toEqual([]);
});

/**
 * THE ALIAS CARRIES THE FILTER, OR IT HANDS OVER THE WRONG CATALOGUE.
 *
 * `/browse` is an alias for `/`, and its own comment says it exists for "the address a user types,
 * bookmarks or is sent by a colleague" — which is precisely the address that carries a filter.
 * `<Navigate to="/" replace />` discarded `search`, so that address arrived unfiltered. Measured in
 * this browser against this corpus before the fix:
 *
 *   /?klass=ham_grant        21 programmes, export links carrying ?klass=ham_grant
 *   /browse?klass=ham_grant  150 programmes, export links BARE
 *
 * Nothing failed. The reader was simply shown the whole catalogue with the product's own "150
 * programmes match" over the top of it, and the file they downloaded matched THAT. This asserts the
 * two addresses are the same view, which is the only thing "alias" can mean.
 */
test('the /browse alias shows the same view as the address it aliases', async ({ page }) => {
  await signIn(page);

  const canonical = await view(page, 'klass=ham_grant');
  expect(canonical.stated).toBeLessThan(await unfilteredTotal(page));

  await page.goto('/browse?klass=ham_grant');
  await awaitResults(page);

  // The alias resolves to the canonical path, still carrying what it was given.
  expect(new URL(page.url()).pathname).toBe('/');
  expect(new URL(page.url()).searchParams.get('klass')).toBe('ham_grant');

  const aliased = await idsOnScreen(page);
  expect(
    aliased.length,
    'the /browse alias dropped the filter and widened the view to the whole corpus',
  ).toBe(canonical.stated);
  expect([...aliased].sort()).toEqual([...canonical.ids].sort());

  await page.goto('/browse?klass=ham_grant');
  await awaitResults(page);
  const fromAlias = csvIds(await downloadText(page, 'CSV'));
  expect(
    fromAlias.length,
    'a file exported from the aliased address is not the file the canonical address exports',
  ).toBe(canonical.stated);
});

/**
 * THE CONTROLS AND THE ADDRESS BAR ARE THE SAME STATE.
 *
 * Every case above navigates straight to a query string, which is legitimate — it is what the
 * browse screen puts in the address bar — but it leaves one link unproved: that pressing the
 * filter controls arrives at the same place. The award-amount box is the right one to press,
 * because `amountMin` is the filter that reached the export links as nothing at all.
 *
 * The file is downloaded from the state the CONTROLS left behind, with no navigation in between.
 */
test('a filter set by hand reaches the file, exactly as the URL does', async ({ page }) => {
  const lastBrowseQuery = trackBrowseRequests(page);
  await signIn(page);
  await page.goto(browseUrl(''));
  await awaitResults(page);
  const unfiltered = csvIds(await downloadText(page, 'CSV'));

  await page.getByLabel('Min', { exact: true }).fill('5000');
  await expect(page).toHaveURL(/amountMin=5000/);
  await awaitResults(page);
  await expectExportCarriesTheView(page, 'CSV', lastBrowseQuery);

  const screenIds = await idsOnScreen(page);
  const stated = await statedOnScreen(page, screenIds.length);
  expect(stated).toBeGreaterThan(0);
  expect(
    stated,
    'the amount floor selected the whole corpus, so this case proves nothing about it',
  ).toBeLessThan(unfiltered.length);

  const typed = csvIds(await downloadText(page, 'CSV'));
  expect(
    typed.length,
    'the file does not match the screen the controls produced',
  ).toBe(stated);
  expect([...typed].sort()).toEqual([...screenIds].sort());
});
