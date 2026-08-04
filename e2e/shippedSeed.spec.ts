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
import { rmSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import {
  bootShippedServer,
  bootstrapAdmin,
  bootstrapTokenFrom,
  OPERATOR_EMAIL,
  OPERATOR_PASSWORD,
  SHIPPED_BASE_URL,
  SHIPPED_DATA_DIR,
  SHIPPED_PORT,
  SHIPPED_SECOND_BOOT_PORT,
  shippedCorpusCounts,
  shippedProgramRowsNamed,
  type BootedServer,
} from './shippedSeed.js';

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

test.beforeAll(async () => {
  // A FRESH install, every run. The whole point of this file is the first boot of an empty
  // DATA_DIR — the one boot on which `importSeedIfEmpty` does anything at all — so a directory
  // left behind by a previous run would silently turn every spec below into a re-boot test.
  rmSync(SHIPPED_DATA_DIR, { recursive: true, force: true });

  server = await bootShippedServer({ port: SHIPPED_PORT, dataDir: SHIPPED_DATA_DIR });
  const token = await bootstrapTokenFrom(server);
  await bootstrapAdmin(SHIPPED_BASE_URL, token);
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
