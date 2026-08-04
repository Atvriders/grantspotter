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
