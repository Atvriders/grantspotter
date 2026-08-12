/**
 * The browser journeys a FRESH INSTALL has, against the corpus a fresh install actually gets.
 *
 * Everything else in this directory drives the fixture harness: 150 publishable records, 553
 * suppressed ones, content-hashed ids. That harness is the right one for the suppression boundary
 * — it is the only corpus here that holds a `do_not_publish` row at all — and those specs are left
 * exactly as they are. It is the wrong one for everything on this page, because a real
 * `docker compose up` never builds it. What a real install boots is `data/seed/*.json`, imported
 * by `importSeedIfEmpty` from the entrypoint, and the two disagree about the id in every deep
 * link: ARDC's grants programme is `ardc-grants` here and `ardc-grants--apply--b04e6201` there.
 *
 * Three properties, and none of them is provable against the fixtures:
 *
 *   1. a canonical deep link resolves and renders the real programme;
 *   2. the corpus a fresh operator sees is the shipped one, whole;
 *   3. a second boot against the same DATA_DIR does not duplicate anything.
 *
 * See `shippedSeed.ts` for why the server is spawned here rather than added as a second
 * `webServer` entry, and for the ids and counts that were measured rather than assumed.
 */
import { existsSync, rmSync, statSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import {
  attemptSignUp,
  bootShippedServer,
  bootstrapAdmin,
  bootstrapTokenFrom,
  firstRunTokenFile,
  OPERATOR_EMAIL,
  OPERATOR_PASSWORD,
  SHIPPED_BASE_URL,
  SHIPPED_DATA_DIR,
  SHIPPED_PORT,
  SHIPPED_SECOND_BOOT_PORT,
  shippedCorpusCounts,
  shippedProgramRowsNamed,
  shippedUserRowFor,
  type BootedServer,
} from './shippedSeed.js';
import { installRenderedHoleSweep } from './renderedHoles.js';

// Every state every journey below passes through is swept for a rendered `undefined`/`null`/
// `NaN`/`[object Object]`. See e2e/renderedHoles.ts.
installRenderedHoleSweep();

// Every spec in this file talks to the fresh-install server, not the fixture one on 3131.
test.use({ baseURL: SHIPPED_BASE_URL });

/**
 * The ARDC record, by the id `data/seed/programs.curated.json` commits and the importer stores
 * verbatim. Hard-coded on purpose, and it is the ONE id in this directory that should be: a
 * canonical id is a promise the seed corpus makes to every bookmark and every link an operator has
 * ever sent a club, and `helpers.ts`'s look-up-by-name would hide a change to it behind a passing
 * test. `programIdByName` exists for the fixture corpus, whose ids carry a content hash and are
 * therefore expected to move when a page is re-captured; these are expected never to move.
 */
const ARDC_PROGRAM_ID = 'ardc-grants';
const ARDC_PROGRAM_NAME = 'ARDC Grants Program';
const ARDC_FUNDER_NAME = 'Amateur Radio Digital Communications';

/**
 * What `importSeedIfEmpty` puts in an empty database, measured on 2026-08-04 by booting
 * `packages/server/dist/index.js` against an empty DATA_DIR and counting the rows it left:
 *
 *   $ DATA_DIR=<empty> node packages/server/dist/index.js
 *   [seed] Imported 143 programs (143 publishable, 0 suppressed) from 26 funders, 141 of them
 *          bound to a crawler identity, all verified 2026-08-02.
 *
 * Zero suppressed is not an oversight in the corpus: the 553 hidden rows are past-award tables,
 * which arrive with the first crawl that reads one, not with the seed. It is also why the
 * suppression specs must keep their fixture harness.
 */
const SHIPPED_PROGRAMS = 143;
const SHIPPED_SUPPRESSED = 0;
const SHIPPED_FUNDERS = 26;
const SHIPPED_CRAWLER_IDENTITIES = 141;

let server: BootedServer | undefined;
let firstBootLog = '';

/**
 * What the first boot did with its one-time setup token, observed AS IT HAPPENED.
 *
 * Every one of these is destroyed by the act of setting the deployment up — the file is deleted
 * when the token is spent, and the log is appended to for the rest of the run — so they are
 * captured in `beforeAll` and asserted in a spec, which is the shape this file already uses for
 * `firstBootLog`. See the spec below for what each one is worth.
 */
const firstRun: {
  token: string;
  tokenPath: string;
  fileMode: number;
  enrollBeforeSetup: { status: number; body: string };
  fileExistsAfterSpending: boolean;
} = {
  token: '',
  tokenPath: '',
  fileMode: 0,
  enrollBeforeSetup: { status: 0, body: '' },
  fileExistsAfterSpending: true,
};

test.beforeAll(async () => {
  // A FRESH install, every run. The whole point of this file is the first boot of an empty
  // DATA_DIR — the one boot on which `importSeedIfEmpty` does anything at all — so a directory
  // left behind by a previous run would silently turn every spec below into a re-boot test.
  rmSync(SHIPPED_DATA_DIR, { recursive: true, force: true });

  server = await bootShippedServer({ port: SHIPPED_PORT, dataDir: SHIPPED_DATA_DIR });

  /*
   * THE ONE MOMENT A DEPLOYMENT IS UNCLAIMED, MEASURED BEFORE IT IS CLAIMED.
   *
   * Registration is open on every deployment now: anybody who can reach this address creates a
   * member account, no invitation and no code. So the question a self-hoster actually has — can a
   * stranger who finds my fresh container before I do take it? — has moved from "how scarce is the
   * credential" to "does the sign-up route refuse while the users table is empty". It does
   * (`api/auth.ts` throws `conflict` with the "has not been set up yet" sentence whenever
   * `bootstrap.required()`), and until this call nothing in the browser suite had ever asked. It is
   * done here rather than in a spec because it is only true for the seconds before the line below.
   */
  firstRun.enrollBeforeSetup = await attemptSignUp(SHIPPED_BASE_URL, {
    email: 'stranger@example.com',
    password: 'a-stranger-password-not-a-real-secret',
  });

  firstRun.tokenPath = firstRunTokenFile(server);
  firstRun.token = await bootstrapTokenFrom(server);
  // Read before the token is spent, because spending it deletes the file.
  firstRun.fileMode = statSync(firstRun.tokenPath).mode & 0o777;

  await bootstrapAdmin(SHIPPED_BASE_URL, firstRun.token);
  firstRun.fileExistsAfterSpending = existsSync(firstRun.tokenPath);
  // Captured now, because the second boot in the last spec appends to its own buffer and this one
  // must still say what the FIRST boot did.
  firstBootLog = server.output();
});

test.afterAll(async () => {
  await server?.stop();
});

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Email').fill(OPERATOR_EMAIL);
  await page.getByLabel('Password').fill(OPERATOR_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
}

test('a fresh install boots the shipped corpus, whole, and says so at the prompt', async ({
  page,
}) => {
  // The line the operator reads. It is quoted in the README, so a reword here is a reword there —
  // which is the point of pinning it: the numbers and the sentence travel together.
  expect(firstBootLog).toMatch(
    new RegExp(
      `\\[seed\\] Imported ${SHIPPED_PROGRAMS} programs \\(${SHIPPED_PROGRAMS} publishable, ` +
        `${SHIPPED_SUPPRESSED} suppressed\\) from ${SHIPPED_FUNDERS} funders`,
    ),
  );

  // And the rows behind the sentence. `withCrawlerIdentity` is the one that matters on the first
  // NIGHTLY run rather than this one: a seeded row with no source_id/external_key is re-minted
  // under a fresh id by `normalizeRaw` and the corpus gains a second copy of it.
  expect(shippedCorpusCounts()).toEqual({
    programs: SHIPPED_PROGRAMS,
    suppressed: SHIPPED_SUPPRESSED,
    funders: SHIPPED_FUNDERS,
    withCrawlerIdentity: SHIPPED_CRAWLER_IDENTITIES,
  });

  // The operator's own view of the same number. Browse is served from the projection table, which
  // `isDoNotPublish` filters, so "the browse total equals every row stored" is what zero suppressed
  // records looks like from the front of the product — and it is the assertion that would fail if
  // this install had somehow booted the fixture corpus, where 553 of 703 rows never reach a page.
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'Browse opportunities' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Opportunities' })).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Pagination' }),
  ).toContainText(`${SHIPPED_PROGRAMS} programmes match`);
});

/**
 * THE FIRST-RUN TOKEN, AND THE MINUTE BEFORE ANYBODY OWNS THE DEPLOYMENT.
 *
 * A NEW SPEC (2026-08-11), and the coverage it adds was previously held by NOTHING. Two changes
 * shipped in the same round and both are about this minute: the token moved out of the boot log
 * into a 0600 file, and the sign-up door was opened to everybody. The e2e harness took part in the
 * first change only as a victim — it used to scrape the token out of stdout with a hex regex, and
 * had to be rewritten to read the file — and a harness that merely stops working is not a test. If
 * the token were printed to stdout again tomorrow, the rewritten harness would go on passing: it
 * reads the file, and the file would still be written. So the properties are asserted here.
 *
 * The `[seed] …` and restart banners are asserted elsewhere in this file; what is asserted here is
 * what the log must NOT contain, what the file's permissions must be, that the file does not
 * outlive its token, and that open registration cannot claim an unclaimed deployment.
 */
test('the setup token stays out of the log, off other users, and does not outlive its use', () => {
  // ---- 1. Nobody can take a fresh deployment, however open sign-up is. ----
  // 409, and the deployment's own sentence rather than a bare status: an operator reading this in
  // a log needs to know their container refused because it is unclaimed, not because of a clash
  // with an account that exists.
  expect(firstRun.enrollBeforeSetup.status).toBe(409);
  expect(firstRun.enrollBeforeSetup.body).toMatch(/has not been set up yet/i);
  // And it created nothing: the bootstrap that follows in `beforeAll` answers 201, which it could
  // not do if a stranger's account had made `bootstrap.required()` false.

  // ---- 2. The secret is not in the log, and the path is. ----
  expect(firstRun.token).toMatch(/^[0-9a-f]{48}$/);
  expect(firstBootLog).toContain('THE TOKEN IS NOT PRINTED IN THIS LOG');
  expect(firstBootLog).toContain(firstRun.tokenPath);
  // The assertion that would fail if the token went back into stdout. Matched as the literal
  // secret rather than as a hex shape, because the log legitimately carries other long hex strings
  // (content hashes among them) and a shape match would be a different, weaker claim.
  expect(
    firstBootLog.includes(firstRun.token),
    'the one-time setup token is in the boot log, which is copied, shipped to log aggregators ' +
      'and read by people who are not the operator',
  ).toBe(false);

  // ---- 3. Only the user this server runs as can read it. ----
  // 0600 exactly: a mode argument to `writeFileSync` is masked by the process umask, so a umask of
  // 0 would leave this world-readable if the explicit `chmod` after it were ever dropped.
  expect(firstRun.fileMode.toString(8)).toBe('600');

  // ---- 4. Spending it removes it. ----
  // A file that survived would be a live administrator credential sitting in the data volume for
  // the rest of the deployment's life — and this volume is the one an operator backs up.
  expect(firstRun.fileExistsAfterSpending).toBe(false);
});

test('a canonical deep link resolves and renders the real programme', async ({ page }) => {
  await signIn(page);

  // The address as an operator would type or bookmark it. Under the fixture corpus this exact URL
  // renders "Could not load this record (not_found)" — the id there is
  // `ardc-grants--apply--b04e6201` — which is how a documented deep link stayed broken in the
  // browser suite while every unit test on the seed corpus passed.
  await page.goto(`/o/${ARDC_PROGRAM_ID}`);

  await expect(page.getByRole('heading', { name: ARDC_PROGRAM_NAME })).toBeVisible();
  // Named rather than counted as "no alerts": the detail page has three legitimate `role="alert"`
  // states (a refused apply URL, a refused non-http address, a failed star), and asserting the
  // absence of all of them would go red for a reason that has nothing to do with this deep link.
  await expect(page.getByText('Could not load this record')).toHaveCount(0);
  await expect(page.getByText(ARDC_FUNDER_NAME, { exact: true })).toBeVisible();

  // A real record, not a shell: the funder's own intake address, offered as a link because
  // `linkRefusal` had nothing to say about that host.
  await expect(page.getByRole('link', { name: 'Apply at the funder' })).toHaveAttribute(
    'href',
    'https://grants.ardc.net',
  );

  // The address bar still reads the id that was typed. A redirect to a minted id would render the
  // same page and quietly break every bookmark that ever pointed here.
  expect(new URL(page.url()).pathname).toBe(`/o/${ARDC_PROGRAM_ID}`);
});

test('a second boot against the same DATA_DIR imports nothing and duplicates nothing', async ({
  page,
}) => {
  const before = shippedProgramRowsNamed(ARDC_PROGRAM_NAME);
  expect(before).toEqual([
    { id: ARDC_PROGRAM_ID, sourceId: 'ardc-grants', externalKey: 'apply' },
  ]);

  // A second real process, the same entrypoint, the same DATA_DIR — a container restart. It gets
  // its own port because the first one is still listening; nothing else about it differs.
  const restart = await bootShippedServer({
    port: SHIPPED_SECOND_BOOT_PORT,
    dataDir: SHIPPED_DATA_DIR,
  });
  try {
    const log = restart.output();
    expect(log).toMatch(new RegExp(`already holds ${SHIPPED_PROGRAMS} records`));
    expect(log).toContain('does not overwrite reviewed data');
    // No fresh admin token either: the banner is printed only while no account exists, and one
    // does. A restart that re-offered a bootstrap token would be a standing way in.
    expect(log).not.toContain('first-run setup');
  } finally {
    await restart.stop();
  }

  // The property the canonical ids exist to guarantee, and the one a content-hashed fixture can
  // never test: the record is still ONE row under the id the seed file names, with its crawler
  // identity intact. A duplicating import leaves two rows with this name and different ids.
  expect(shippedProgramRowsNamed(ARDC_PROGRAM_NAME)).toEqual(before);
  expect(shippedCorpusCounts().programs).toBe(SHIPPED_PROGRAMS);

  // And from the front of the product, through the FIRST server, which never restarted. This is
  // what a duplicating import looks like to a user: the same programme listed twice, under two
  // ids, each with its own deadline to miss. One row, and the link on it is the canonical address.
  await signIn(page);
  await expect(
    page.getByRole('navigation', { name: 'Pagination' }),
  ).toContainText(`${SHIPPED_PROGRAMS} programmes match`);

  await page.goto(`/?q=${encodeURIComponent(ARDC_PROGRAM_NAME)}`);
  const listed = page.getByRole('link', { name: ARDC_PROGRAM_NAME, exact: true });
  await expect(listed).toHaveCount(1);
  await expect(listed).toHaveAttribute('href', `/o/${ARDC_PROGRAM_ID}`);
});

/**
 * A STUDENT SIGNS THEMSELVES UP, ON A REAL SERVER, AND GETS A MEMBER ACCOUNT.
 *
 * A NEW SPEC (2026-08-11), AND THE GAP IT CLOSES IS THE ROUND'S HEADLINE FEATURE. Registration was
 * opened this round — no enrollment code, no invitation, anybody who can reach the deployment makes
 * their own account — and when the work was done, the number of end-to-end tests that had ever
 * created an account through the sign-up form was ZERO. Every proof of it was one of two kinds:
 * `packages/web/src/routes/Enroll.test.tsx` and `App.test.tsx` drive the form against a stubbed
 * `fetch` in jsdom, and `packages/server/src/api/enroll.test.ts` drives the route with supertest
 * against an in-process app. Neither has ever seen the other. Unmount the route, change the shape
 * of the body the browser posts, or stop setting the session cookie on a 201, and every one of
 * those files stays green — which is the same gap that let a documented deep link stay broken while
 * every unit test passed, two specs above.
 *
 * It runs here because this is the only file with a REAL fresh install to sign up to: the corpus is
 * the shipped one, the administrator was created through `POST /api/auth/bootstrap` the way an
 * installation creates one, and registration has been open since the moment that returned.
 *
 * Declared last on purpose. It is the only spec in this file that WRITES to the deployment, and the
 * three above assert corpus counts and boot logs that a new `users` row must not be able to move.
 */
test('anybody can create their own account from the sign-in screen, and gets a member', async ({
  page,
}) => {
  const STUDENT_EMAIL = 'new.student@example.edu';
  const STUDENT_PASSWORD = 'e2e-new-student-password-not-a-real-secret';

  // Nobody has this address yet, asserted rather than assumed: a leftover row from an earlier run
  // would turn the 201 below into a 409 and this spec into a test of the conflict path.
  expect(shippedUserRowFor(STUDENT_EMAIL)).toBeNull();

  await page.goto('/');
  // The sign-in screen, because an administrator exists — and the offer of a second door on it,
  // which is unconditional now. There is no code field to fill in and no question asked first.
  await page.getByRole('heading', { name: 'Sign in' }).waitFor();
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByRole('heading', { name: 'Create your account' }).waitFor();

  await page.getByLabel('Email').fill(STUDENT_EMAIL);
  await page.getByLabel('Display name (optional)').fill('A New Student');
  await page.getByLabel('Password').fill(STUDENT_PASSWORD);
  await page.getByRole('button', { name: 'Create my account' }).click();

  // SIGNED IN BY THE ACT OF SIGNING UP: the 201 carries the session cookie, so the refresh it
  // triggers lands inside the shell rather than back on a form. This is the half that no stubbed
  // test can prove, because the cookie is the server's.
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Browse opportunities' })).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Pagination' }),
  ).toContainText(`${SHIPPED_PROGRAMS} programmes match`);

  // A MEMBER, read out of the database rather than inferred from what the screen offered. The
  // route passes the literal `member`; `role` is not a parameter of the request, and the only way
  // to a second administrator is an existing one promoting somebody.
  expect(shippedUserRowFor(STUDENT_EMAIL)).toEqual({
    role: 'member',
    displayName: 'A New Student',
    disabled: 0,
  });
  // And the screen agrees with the row: no admin console in the navigation.
  await expect(page.getByRole('link', { name: 'Admin', exact: true })).toHaveCount(0);

  // The same address a second time is refused, and refused in a way that helps: this is the one
  // failure this form has that is about somebody else's account rather than the person's typing.
  const again = await attemptSignUp(SHIPPED_BASE_URL, {
    email: STUDENT_EMAIL,
    password: STUDENT_PASSWORD,
  });
  expect(again.status).toBe(409);
  expect(again.body).toMatch(/already/i);
});
