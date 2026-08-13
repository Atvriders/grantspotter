/**
 * The browser journeys: spec §17's flow, driven through the real SPA against the real server.
 *
 *   log in → set profile → browse with verdicts → star → calendar → receive a change event
 *
 * WHY THESE ARE SKIPPED AT THE END OF PLAN 3, AND WHAT UN-SKIPS THEM (RESOLUTIONS R16 + R25).
 * Every spec here starts at `page.goto('/')`, and `/` is served by the SPA middleware that is the
 * LAST statement of Task 14's `mountRoutes` callback. That middleware is Plan 5's: `api/spa.ts` is
 * created by Plan 5's SPA task and mounted by Plan 5 Task 17. Plan 3 deliberately does not
 * forward-reference it, because importing a file that does not exist fails `npm run build`, and a
 * failed build means `packages/server/dist/index.js` is never emitted and this config's
 * `webServer` never starts at all — which would take `typecheck`, `build` and `npm test` down with
 * it.
 *
 * DEVIATION FROM THE TASK BRIEF (2026-08-04). The brief leaves these four specs FAILING on their
 * first line until Plan 5. A permanently red suite is indistinguishable from a newly red one: the
 * next agent to run `npm run test:e2e` cannot tell the expected failure from the regression they
 * just introduced, which is the exact "an absence of failure is the symptom" problem this repo
 * hunts, inverted. So each spec asks the running server what `/` actually answers and skips with
 * the reason above when the fallback is absent. It is not a hard-coded skip: the moment Plan 5
 * Task 17 appends `a.use(createSpaMiddleware(webDistRoot()));`, `/` returns `<!doctype html>` and
 * all four run, with no edit to this file. The spec directly below is what keeps that honest — it
 * always runs, and fails if `/` is in any state other than the two named here.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  ARRL_CATALOG_SOURCE_ID,
  ARRL_SCHOLARSHIP_NAME,
  insertChangeEvent,
  MEMBER_EMAIL,
  MEMBER_PASSWORD,
  NEWCOMER_EMAIL,
  NEWCOMER_PASSWORD,
  programIdByName,
} from './helpers.js';
import {
  drainRenderedHoles,
  injectHoleForSelfTest,
  installRenderedHoleSweep,
} from './renderedHoles.js';

// Every state every journey below passes through is swept for a rendered `undefined`/`null`/
// `NaN`/`[object Object]`. See e2e/renderedHoles.ts.
installRenderedHoleSweep();

/**
 * The ARDC record the writing desk binds an overlay to — the same one `writing.spec.ts` names.
 * "Apply for a Grant" is the page title ardc.net publishes; it is looked up by name for the reason
 * `programIdByName` exists, and never transcribed as an id.
 */
const ARDC_PROGRAM_NAME = 'Apply for a Grant';

/**
 * Read the system clipboard from inside the page.
 *
 * DEVIATION FROM THE TASK BRIEF (2026-08-04). The brief writes
 * `page.evaluate(() => navigator.clipboard.readText())`, which does not compile: this repository's
 * ROOT tsconfig ships no `dom` lib and `npm run typecheck` covers `e2e/`, so `navigator` is
 * `TS2304: Cannot find name 'navigator'` — the same wall `writing.spec.ts` documents for
 * `document`. The body of this function is evaluated in Chromium, where `navigator.clipboard`
 * really is there; only the TYPE has to be supplied here, and it is supplied narrowly rather than
 * with an `any` so a misspelt method is still a compile error.
 */
function readClipboard(): Promise<string> {
  const { navigator } = globalThis as unknown as {
    navigator: { clipboard: { readText(): Promise<string> } };
  };
  return navigator.clipboard.readText();
}

const SPA_PENDING =
  'The SPA fallback is not mounted: GET / is still Plan 1\'s JSON 404 envelope. Plan 5 Task 17 ' +
  'appends `a.use(createSpaMiddleware(webDistRoot()));` at Task 14\'s reservation comment in ' +
  'packages/server/src/index.ts, and every spec in this file runs from that moment on with no ' +
  'edit here. Nothing else about the harness is waiting: api.spec.ts drives the same server today.';

/** The ARRL catalog source's registry label, which the Sources page renders. */
const ARRL_CATALOG_LABEL = 'ARRL Foundation Scholarship catalog';

/**
 * Open the app, or skip this spec because Plan 5's SPA middleware is not mounted yet.
 * A JSON 404 at `/` is the one permitted state; anything else is a defect and the guard spec
 * below turns it red rather than letting it read as "not ready yet".
 */
async function openApp(page: Page): Promise<void> {
  const response = await page.goto('/');
  const body = (await response?.text()) ?? '';
  test.skip(!/^\s*<!doctype html/i.test(body), SPA_PENDING);
}

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await openApp(page);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
}

/**
 * THE SWEEP, DEMONSTRATED CATCHING ONE.
 *
 * Every other spec in this suite passes the sweep by not tripping it, and a check that has never
 * been watched failing is indistinguishable from a check that matches nothing: an `addInitScript`
 * that threw, a `MutationObserver` that never armed because `document.body` was still null, a
 * regex mangled by one round of string escaping. All three are silent, and all three leave 53
 * green tests and no guard. `contactUrlEntryPointContract.test.ts` was walked past three separate
 * ways for exactly this reason, and each hole was found only by writing an offender.
 *
 * So this writes the offender — round two's own sentence — into the real page in the real browser,
 * and reads it back out of the observer. `drainRenderedHoles` clears as it reads, so the per-test
 * check that follows finds the page clean again.
 */
test('the rendered-hole sweep is armed, and sees a hole when there is one', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#root')).toBeAttached();

  expect(await drainRenderedHoles(page), 'the signed-out screen must be clean').toEqual([]);

  await page.evaluate(injectHoleForSelfTest);
  const seen = await drainRenderedHoles(page);

  expect(seen.length, 'the observer saw nothing — it is not armed').toBeGreaterThan(0);
  expect(seen.join('\n')).toMatch(/printed "undefined"/);
  expect(seen.join('\n')).toMatch(/FCC record for/);
});

test('GET / is in exactly one of the two states this suite knows about', async ({ request }) => {
  const response = await request.get('/');
  const body = await response.text();
  const isSpa = /^\s*<!doctype html/i.test(body);
  const isPlan3JsonNotFound =
    response.status() === 404 &&
    (response.headers()['content-type'] ?? '').includes('application/json') &&
    (JSON.parse(body) as { error: { code: string } }).error.code === 'not_found';

  expect(
    isSpa || isPlan3JsonNotFound,
    `GET / answered ${response.status()} ${response.headers()['content-type'] ?? ''} — neither ` +
      "Plan 1's JSON 404 (Plan 3) nor the SPA's index.html (Plan 5). The browser journeys in this " +
      'file skip on the first and run on the second; a third state means something else now owns ' +
      `/ and this suite is measuring the wrong thing.\n${body.slice(0, 300)}`,
  ).toBe(true);
});

test('log in, set a profile, browse with verdicts, star, calendar, receive a change event', async ({
  page,
}) => {
  // --- log in --------------------------------------------------------------
  // A user who holds no profile at all, so the "no profile yet" state below is this account's
  // real state and not whatever a previous spec left behind.
  await signIn(page, NEWCOMER_EMAIL, NEWCOMER_PASSWORD);
  await expect(page.getByRole('heading', { name: 'Browse opportunities' })).toBeVisible();

  // Before a profile exists, the app says so instead of showing silent nulls.
  await expect(page.getByRole('link', { name: /set up a profile/i }).first()).toBeVisible();

  // --- set the profile -----------------------------------------------------
  // `exact: true` because the browse banner's "Set up a profile" link also contains the word,
  // and Playwright's role matcher is a substring match: without it this resolves to two links.
  await page.getByRole('link', { name: 'Profile', exact: true }).click();
  await page.getByLabel('Callsign').fill('W8UM');
  await page.getByLabel('License class').selectOption('GENERAL');
  await page.getByLabel('State').fill('MI');
  await page.getByLabel('Degree level').selectOption('BACH');
  await page.getByLabel('Stage').selectOption('UNDERGRAD');
  await page.getByLabel('Citizenship').selectOption('US_CITIZEN');
  await page.getByRole('button', { name: /save student profile/i }).click();
  await expect(
    page.getByText('Student profile saved. Completeness is now measured against it.'),
  ).toBeVisible();

  // The completeness meter is expressed in unknown verdicts, not fields filled, and it names the
  // profile it speaks for rather than leaving a two-profile user to guess.
  await expect(page.getByRole('meter', { name: 'Profile completeness' })).toBeVisible();
  await expect(page.getByText('Measured against your student profile.')).toBeVisible();
  // "Waiting on", never "becomes an answer": the matcher short-circuits per axis, so filling one
  // field moves an unknown along rather than resolving it.
  await expect(
    page.getByRole('region', { name: 'What your unknown verdicts are waiting on' }),
  ).toBeVisible();

  // --- browse with verdicts ------------------------------------------------
  await page.getByRole('link', { name: 'Browse', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Opportunities' })).toBeVisible();
  await expect(page.getByText(/You are ineligible for \d+ of these/)).toBeVisible();
  // `unknown` is a labelled state and the page refuses to let it read as a soft no.
  await expect(page.getByText(/Unknown is not a/)).toBeVisible();

  /*
   * ...AND IT DOES NOT BLAME THE READER FOR IT. This paragraph read "It means something a program
   * asks for could not be answered from your profile yet" until 2026-08-12, which pins every
   * `unknown` in the corpus on a gap in the READER. Against the real seeded corpus and a real
   * profile — which is why the check is here and not only over a stubbed summary in
   * `Browse.test.tsx` — most of them are not: `e2e/api.spec.ts` measures this same server at 27
   * unknown for this applicant, of which 20 carry an EMPTY `missingProfileFields` and are named
   * there one by one. Nineteen are records whose applicant list nobody ever filled in and one is a
   * radius whose centre never resolved to a coordinate; all twenty are holes in GrantSpotter's own
   * data that no field of the reader's could close.
   *
   * `VerdictBadge`'s title was corrected for exactly this and this paragraph, directly above the
   * table on the same screen, was not. Stated as a prohibition so rewording stays free.
   */
  const censusNote = page.getByText(/waiting on an answer rather than ruling you out/);
  await expect(censusNote).toBeVisible();
  await expect(censusNote).not.toContainText(/(?:answered|evaluated) from your profile/i);
  await expect(censusNote).toContainText(/the record itself never stated it/i);

  // Every honesty surface is reachable from the list. `Status: unknown` is the raw state, spelled
  // out — 118 of the 150 records carry it, and a blank cell there is a bug.
  await expect(page.getByLabel('Status: unknown').first()).toBeVisible();
  // Every record carries its verification age. Nothing in this corpus is stale enough to be amber,
  // so the assertion is that the badge is there and says when, not that it is a warning.
  await expect(page.getByLabel(/^Verified /).first()).toBeVisible();

  // The Chicago FM record: discontinued, yet still listed by aggregators that mirror ARRL data
  // years out of date. Reached by search so the assertion does not depend on page size.
  await page.getByRole('searchbox').fill('Chicago FM');
  await expect(page.getByText(/mirror stale ARRL data/)).toBeVisible();

  // The FAR record is a warning, never a link to the domain that was taken over.
  await page.getByRole('searchbox').fill('Foundation for Amateur Radio');
  await expect(page.getByRole('note', { name: 'Safety warning' }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: /farweb/i })).toHaveCount(0);
  await page.getByRole('searchbox').fill('');

  // The specific constraint for an ineligible row is one click away, quoted in the funder's words.
  await page.getByRole('link', { name: 'see the specific constraint for each' }).click();
  await page.waitForURL(/verdict=ineligible/);
  // WAIT FOR THE FILTERED PAGE TO LAND BEFORE TOUCHING A ROW. `expandedId` is a program id held in
  // Browse's own state, and `.first()` is re-resolved on every action: clicking while the verdict
  // filter is still in flight expands the first row of the OLD list, which is then no longer the
  // first row of the new one, and the assertion reads a different badge than the one clicked.
  await page.waitForLoadState('networkidle');
  const explain = page.getByRole('button', { name: /^Ineligible, \d+ constraints? not met$/ }).first();
  await expect(explain).toHaveAttribute('aria-expanded', 'false');
  await explain.click();
  await expect(explain).toHaveAttribute('aria-expanded', 'true');
  // An `aria-expanded="true"` that reveals nothing is a promise the interface does not keep, so
  // what opens is the funder's own wording for each unmet constraint.
  await expect(page.locator('.reasons-list li').first()).toBeVisible();

  // --- star a program ------------------------------------------------------
  const arrlId = programIdByName(ARRL_SCHOLARSHIP_NAME);
  await page.goto(`/o/${arrlId}`);
  await expect(page.getByRole('heading', { name: ARRL_SCHOLARSHIP_NAME })).toBeVisible();
  await page.getByRole('button', { name: 'Watch this program' }).click();
  await expect(page.getByRole('button', { name: 'Stop watching this program' })).toBeVisible();

  // --- calendar ------------------------------------------------------------
  await page.getByRole('link', { name: 'Calendar', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Agenda' })).toBeVisible();
  await expect(page.getByText(/Start by \d{4}-\d{2}-\d{2}/).first()).toBeVisible();
  // A projected date says so in words. Only four cycles in the whole corpus are funder-published.
  await expect(page.getByText('Projected, not observed').first()).toBeVisible();

  // The month view is a plain <table>: `role="grid"` was removed deliberately, because grid
  // advertises an arrow-key contract over a roving tabindex that this component does not implement.
  await page.getByRole('tab', { name: 'Month' }).click();
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.getByRole('grid')).toHaveCount(0);

  // December 2026 is where 113 chips land on one day, and the page folds 112 of them behind the
  // sentence that says why: they are not 113 deadlines, they are one deadline 112 applications
  // ride on. The apostrophe is U+2019.
  for (let i = 0; i < 12; i += 1) {
    if (await page.getByRole('table', { name: 'December 2026' }).isVisible()) break;
    await page.getByRole('button', { name: 'Next month' }).click();
  }
  await expect(page.getByRole('table', { name: 'December 2026' })).toBeVisible();
  await expect(
    page.getByText(`112 programmes ride ${ARRL_SCHOLARSHIP_NAME}’s deadline`),
  ).toBeVisible();

  // --- a change event lands on the watched program -------------------------
  // "ARRL moved the scholarship close from Jan 31 to Dec 30" — spec §11.2. A real row in the real
  // table the nightly crawl writes; the drain, the fan-out and the rendering are all the product's.
  insertChangeEvent({
    id: 'e2e-ui-deadline-change',
    sourceId: ARRL_CATALOG_SOURCE_ID,
    programId: arrlId,
    kind: 'deadline_changed',
    before: 'January 31',
    after: 'December 30, 12:00 PM EST',
    detectedAt: new Date().toISOString(),
    fieldPath: 'deadline.note',
  });

  await page.getByRole('link', { name: /watchlist/i }).click();
  const digest = page.getByRole('region', { name: 'Change digest' });
  await expect(digest.getByText(`Deadline changed: ${ARRL_SCHOLARSHIP_NAME}`)).toBeVisible();
  // `exact` on both: each value appears twice in the card — once as the was/now chip and once
  // inside the advice sentence — and a substring match resolves to two nodes.
  await expect(digest.getByText('January 31', { exact: true })).toBeVisible();
  await expect(digest.getByText('December 30, 12:00 PM EST', { exact: true })).toBeVisible();
  // One date moving is 113 applications moving, and the digest says so.
  await expect(digest.getByText(/112 other programmes inherit this cycle/)).toBeVisible();

  // And it is actionable: open the record, then clear it. Clearing marks it read; it does not
  // erase what happened.
  await expect(digest.getByRole('link', { name: 'Open the record' }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Mark all read' }).click();
  await expect(digest.getByText(`Deadline changed: ${ARRL_SCHOLARSHIP_NAME}`)).toBeVisible();
});

test('a member sees the inbox but cannot decide', async ({ page }) => {
  await signIn(page, MEMBER_EMAIL, MEMBER_PASSWORD);

  await page.getByRole('link', { name: 'Inbox', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  await expect(
    page.getByText(
      'This queue is read-only for your account: only an administrator can approve or reject a change.',
    ),
  ).toBeVisible();
  // Absent, not disabled — and the page says nothing has gone wrong, which is the difference
  // between a permission boundary and a broken screen.
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reject', exact: true })).toHaveCount(0);
});

test('the sources health page is readable by a member, and offers them no controls', async ({
  page,
}) => {
  await signIn(page, MEMBER_EMAIL, MEMBER_PASSWORD);

  await page.getByRole('link', { name: 'Sources', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Source health' })).toBeVisible();
  await expect(
    page.getByText(
      'Only an administrator can change source configuration or trigger a crawl. This page is ' +
        'readable by everyone so that a wrong-looking record can always be traced to its source.',
    ),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run crawl now' })).toHaveCount(0);

  // The blocklist is stated on the page and is not configurable from it.
  await expect(page.getByRole('heading', { name: 'Hosts the fetcher refuses' })).toBeVisible();

  // The Admin route is not offered, and typing the URL does not reach it.
  await expect(page.getByRole('link', { name: 'Admin', exact: true })).toHaveCount(0);
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Browse opportunities' })).toBeVisible();
});

test('an admin manages users, configures a source, and triggers a crawl', async ({ page }) => {
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

  // --- user management (spec §12, "User management | admin ✅ | member ❌") ---
  await page.getByRole('link', { name: 'Admin', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Admin' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'User accounts' })).toBeVisible();

  await page.getByLabel(/New account email/).fill('second-member@example.com');
  await page.getByLabel(/New account role/).selectOption('member');
  await page.getByRole('button', { name: 'Create account' }).click();

  // The generated password is shown once, and the new row appears.
  await expect(page.getByText(/This is shown once\./)).toBeVisible();
  await expect(page.getByRole('table', { name: 'User accounts' })).toContainText(
    'second-member@example.com',
  );

  // Restore is guarded by a typed confirmation AND a chosen file, not a single click.
  await expect(page.getByRole('button', { name: 'Restore from backup' })).toBeDisabled();
  await page.getByLabel(/Type REPLACE to confirm/).fill('REPLACE');
  await expect(page.getByRole('button', { name: 'Restore from backup' })).toBeDisabled();

  // --- source configuration and the manual crawl (spec §12) ---
  await page.getByRole('link', { name: 'Sources', exact: true }).click();
  const baseline = page.getByLabel(`Expected minimum records, the yield baseline for ${ARRL_CATALOG_LABEL}`);
  await baseline.fill('105');
  await page.getByRole('button', { name: `Save ${ARRL_CATALOG_LABEL}` }).click();
  await expect(baseline).toHaveValue('105');

  // CRAWL_ENABLED is false for the e2e server, so the scheduler never fires; this button is the
  // only thing that runs a crawl in this process, and it runs the identical CrawlDeps the 03:17
  // run would. The seed leaves exactly one source enabled — the hand-curated Tier D module, whose
  // `requests` list is empty — and `runCrawl` honours `sources.enabled` on the manual path too, so
  // this walks the whole crawl path and reaches no third-party site.
  await page.getByRole('button', { name: 'Run crawl now' }).click();
  await expect(page.getByRole('status')).toContainText(/Crawled 1 source/, { timeout: 60_000 });
});

/**
 * SPEC §14, ALL NINE STEPS, IN ONE SESSION.
 *
 * Deliberately one long test rather than nine short ones: what is being asserted is that the steps
 * COMPOSE — that a profile saved in step 2 is the profile the export in step 6 is computed
 * against, and that the programme starred in step 4 is still starred when the calendar reads it.
 * Nine isolated tests prove nine screens render and nothing about the chain between them.
 *
 * DEVIATIONS FROM THE TASK BRIEF (2026-08-04), each measured against the running server:
 *
 *   a. The brief navigates to `/o/arrl-foundation-scholarships` and `/o/ardc-grants`. Neither id
 *      exists. Programme ids are minted by the normalizer and carry a content hash of the source
 *      record — the two real ids are `arrl-scholarship-program--scholarship-program--7b29405e` and
 *      `ardc-grants--apply--b04e6201` — so both `goto`s land on the detail route's "not found" and
 *      the star step asserts against a page with no Watch button. `programIdByName` is the lookup
 *      `helpers.ts` exists to provide and `writing.spec.ts` already uses.
 *   b. `getByRole('link', { name: 'Profile' })` resolves to two nodes: the rail entry and the
 *      browse banner's "Set up a profile". `exact: true`, as Plan 3's journey above already does.
 *   c. `getByLabel('Draft')` needs `exact: true` (the screen also labels "Draft title"), and a
 *      controlled textarea's text is its `value`, so the assertion is `toHaveValue` and not
 *      `toContainText` — `textContent` on a React-controlled textarea is empty and the brief's
 *      form passes for the wrong reason or fails for one that is not the product's.
 */
test('spec §14: log in, profile, browse, star, calendar, ICS, template, prompt, prose check', async ({
  page,
}) => {
  // 1 — log in
  await signIn(page, MEMBER_EMAIL, MEMBER_PASSWORD);
  await expect(page.getByRole('heading', { name: 'Browse opportunities' })).toBeVisible();

  // 2 — set a profile
  await page.getByRole('link', { name: 'Profile', exact: true }).click();
  await page.getByLabel('Callsign').fill('W8UM');
  await page.getByLabel('License class').selectOption('GENERAL');
  await page.getByLabel('State').fill('MI');
  await page.getByLabel('Degree level').selectOption('BACH');
  await page.getByLabel('Stage').selectOption('UNDERGRAD');
  await page.getByLabel('Citizenship').selectOption('US_CITIZEN');
  await page.getByRole('button', { name: /save student profile/i }).click();
  // NAMED, because this form keeps two live regions since 2026-08-13: the save confirmation beside
  // Save, and what accepting an FCC record moved in the form, beside the lookup that moved it. A
  // bare `getByRole('status')` is a strict-mode violation now, and naming the one this step is
  // about is the assertion this line was always making.
  await expect(
    page.getByRole('status', { name: /whether this profile has been saved/i }),
  ).toContainText('saved');

  // 3 — browse with verdicts
  await page.getByRole('link', { name: 'Browse', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Opportunities' })).toBeVisible();
  await expect(page.getByText(/you are ineligible for \d+ of these/i)).toBeVisible();

  // 4 — star a program
  const arrlId = programIdByName(ARRL_SCHOLARSHIP_NAME);
  await page.goto(`/o/${arrlId}`);
  await page.getByRole('button', { name: 'Watch this program' }).click();
  await expect(page.getByRole('button', { name: 'Stop watching this program' })).toBeVisible();
  // The brief is printable, which is how spec §11.3 delivers "Opportunity brief | PDF".
  await expect(page.getByRole('button', { name: 'Print brief' })).toBeVisible();

  // 5 — calendar
  await page.getByRole('link', { name: 'Calendar', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Agenda' })).toBeVisible();

  // 6 — export ICS, through the UI a user actually has
  await page.getByRole('link', { name: 'Exports', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Take it with you' })).toBeVisible();
  // A BUTTON, NOT A LINK, AND THE JOURNEY IS WHERE THAT CHANGE IS FELT. An `<a download>` hands
  // the response to the browser unread: on `/exports` that is how a 409 JSON body came to be saved
  // as `eligibility.csv`, and how an empty watchlist calendar was saved as though it were an
  // answer. These controls fetch, check, and only then write — the file that lands is unchanged,
  // including the server-stamped name asserted below.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /one-off \.ics$/i }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^grantspotter-deadlines-\d{4}-\d{2}-\d{2}\.ics$/);
  const icsPath = await download.path();
  const ics = readFileSync(icsPath, 'utf8');
  expect(ics.startsWith('BEGIN:VCALENDAR')).toBe(true);
  expect(ics).toContain('BEGIN:VEVENT');
  // The subscribable feed is the one that keeps working; prove it is creatable and serves.
  await page.getByRole('button', { name: /create a calendar feed/i }).click();
  const feedUrl = await page.getByLabel(/subscribe url/i).inputValue();
  expect(feedUrl).toMatch(/\/calendar\/[A-Za-z0-9_-]{40,}\.ics$/);
  const feed = await page.request.get(feedUrl);
  expect(feed.status()).toBe(200);
  expect(feed.headers()['content-type']).toContain('text/calendar');
  expect(await feed.text()).toMatch(/^BEGIN:VCALENDAR/);

  // 7 — open a template, from the program so the funder overlay resolves
  const ardcId = programIdByName(ARDC_PROGRAM_NAME);
  await page.goto(`/o/${ardcId}`);
  await page.getByRole('link', { name: 'Start an application for this program' }).click();
  await expect(page).toHaveURL(new RegExp(`/applications\\?programId=${ardcId}`));
  await page.getByRole('button', { name: 'New draft' }).click();
  const draft = page.getByLabel('Draft', { exact: true });
  await page
    .getByRole('region', { name: 'Insert a section' })
    .getByRole('button', { name: /^Need statement/ })
    .click();
  await expect(draft).toHaveValue(/\[TODO:/);

  // 8 — copy an AI prompt, and check what actually reached the clipboard
  await page.getByRole('button', { name: 'Copy AI Prompt — includes AI-detection avoidance' }).click();
  // Wait for the button's own "Copied N characters" before reading the clipboard. The click
  // returns as soon as it is dispatched, and the handler fetches the composed prompt from the
  // server before it writes — so the brief's immediate read races it and returns `''`, which is
  // what an empty assertion failure looked like here first time round.
  await expect(page.getByRole('status')).toContainText(/^Copied [\d,]+ characters\./);
  const clipboard = await page.evaluate(readClipboard);
  expect(clipboard).toContain('ARDC');
  expect(clipboard.length).toBeGreaterThan(400);

  // 9 — run the prose check
  await draft.fill(
    "In today's rapidly evolving landscape, our organization delves into the transformative " +
      'potential of amateur radio, underscoring our unwavering commitment to educate, empower and inspire.',
  );
  await draft.blur();
  await page.getByRole('button', { name: 'Run prose check' }).click();
  await expect(page.getByRole('heading', { name: 'Prose check' })).toBeVisible();
  await expect(page.getByText(/has no proper noun and no figure in it/i)).toBeVisible();
});

/**
 * Playwright's `webServer` is the real entrypoint, so the same four guarantees `spa.test.ts` pins
 * on a hand-built app are worth one more check against the thing the browser is actually talking
 * to. `request` rather than `page`, because two of the four are about what is *not* HTML.
 *
 * Relative paths resolve against playwright.config.ts's baseURL, which points at the
 * same single process the container runs.
 */
test('the single process serves the SPA on / and still answers JSON on /api', async ({ request }) => {
  const root = await request.get('/');
  expect(root.status()).toBe(200);
  expect(root.headers()['content-type']).toContain('text/html');
  const shell = await root.text();
  expect(shell).toContain('<div id="root">');

  // A deep client-side route returns the SAME shell: that is what makes a hard
  // refresh on /browse work, and it is Plan 5 Task 17's line that provides it.
  const deep = await request.get('/browse');
  expect(deep.status()).toBe(200);
  expect(await deep.text()).toBe(shell);

  // The history fallback must not have swallowed the API.
  const unknown = await request.get('/api/unknown');
  expect(unknown.status()).toBe(404);
  expect(unknown.headers()['content-type']).toContain('application/json');
  const envelope = (await unknown.json()) as { error: { code: string }; requestId: string };
  expect(envelope.error.code).toBe('not_found');
  expect(typeof envelope.requestId).toBe('string');

  // Only a GET gets the shell; a POST falls through to the JSON 404.
  const posted = await request.post('/', { data: {} });
  expect(posted.status()).toBe(404);
  expect(posted.headers()['content-type']).toContain('application/json');
  expect(await posted.text()).not.toContain('<div id="root">');
});

/**
 * WHAT A MEMBER AN ADMINISTRATOR HAS SWITCHED OFF IS TOLD — IN A BROWSER, WHICH IS THE ONLY PLACE
 * IT WAS EVER GOING TO BE READ.
 *
 * `packages/server/src/api/auth.ts` grew a sentence of its own for this state on 2026-08-12,
 * with a docblock arguing at length that "Incorrect email or password." is false in the direction
 * that costs the reader the most: it sends the one person who cannot fix anything off to reset a
 * password that was never wrong, and this product has no reset mail. That fix was real and
 * `packages/server/test/api.auth.test.ts` covers it — over HTTP.
 *
 * NOTHING COVERED THE BROWSER, and the browser threw the sentence away. `routes/Login.tsx`
 * answered every `unauthorized` code with its own hardcoded "That email or password was not
 * recognised." — so curl got the truth and the student got the falsehood, which is the audience
 * that matters. Measured 2026-08-12 in the Chromium this suite drives, against a real disabled
 * account on the real server, before the fix:
 *
 *   API   401 {"error":{"code":"unauthorized","message":"That account has been switched off …"}}
 *   SCREEN "That email or password was not recognised."
 *
 * So the assertion is on what is ON THE SCREEN and not on what the API answered: an API-level
 * assertion is what already existed and it is exactly what was green while this was broken.
 *
 * The account is created here rather than seeded, and disabled and left disabled, so no other spec
 * in this file or any other loses an account it was relying on.
 */
test('a member an administrator switched off is told so in the browser, not blamed for their password', async ({
  page,
  request,
}) => {
  const email = `switched-off-${String(Date.now())}@example.org`;
  const password = 'e2e-switched-off-password-not-a-real-secret';

  const created = await request.post('/api/auth/enroll', { data: { email, password } });
  expect(created.status()).toBe(201);

  // Disabled through the real admin route, the way an operator does it.
  const signedIn = await request.post('/api/auth/login', {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(signedIn.status()).toBe(200);
  const list = (await (await request.get('/api/admin/users')).json()) as {
    rows: Array<{ id: string; email: string }>;
  };
  const row = list.rows.find((r) => r.email === email);
  expect(row, 'the account this test just created is missing from the admin list').toBeTruthy();
  const patched = await request.patch(`/api/admin/users/${String(row?.id)}/disabled`, {
    data: { disabled: true },
  });
  expect(patched.status()).toBe(200);

  // The API's own answer, quoted here only so a failure says which half moved.
  const apiAnswer = await request.post('/api/auth/login', { data: { email, password } });
  expect(apiAnswer.status()).toBe(401);
  const apiMessage = ((await apiAnswer.json()) as { error: { message: string } }).error.message;
  expect(apiMessage).toContain('switched off by an administrator');

  // And now the half nothing was watching.
  await openApp(page);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  const alert = page.getByRole('alert');
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('switched off by an administrator');
  // The specific falsehood, named, so a regression fails by the sentence that was wrong rather
  // than as an unexplained text mismatch.
  await expect(alert).not.toContainText('That email or password was not recognised.');
  // Still signed out: the page must not have navigated into the shell.
  await expect(page.getByRole('navigation', { name: 'Primary' })).toHaveCount(0);
});
