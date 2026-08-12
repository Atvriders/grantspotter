/**
 * THE RESPONSIVE CONTRACT, MEASURED: no page may require a horizontal scroll at any width from
 * 320px up.
 *
 * `packages/web/src/test/responsive.test.ts` is honest that jsdom cannot measure a pixel and has
 * always pointed at "the e2e suite" for the measurement itself. Until 2026-08-10 there was nothing
 * here to point at: no file under `e2e/` mentioned `scrollWidth`. The pointer was the claim, and
 * the claim was false. This file is the measurement.
 *
 * WHY IT SAMPLES RECORDS RATHER THAN WIDTHS — the lesson that cost 78% of the corpus.
 *
 * The commit that fixed the 2565px grid blowout reported "0 of 84 route × width combinations
 * overflow" and a continuous sweep of "12,331 width-samples, 0 overflowing". Both figures were
 * true. Both were blind. Every one of those samples opened `/o/:id` for the SAME record, and that
 * record is one of the 31 of 143 whose addresses happen to be short. Meanwhile 112 of the 143
 * shipped records scrolled sideways at 320, 360, 390, 414, 640, 700, 1024, 1280 and 1440 alike, in
 * both themes, because `SourceLink` printed the funder's URL as its own link text and a URL has no
 * spaces in it — one word, whose rendered width becomes a floor under the whole page. (Measured
 * 2026-08-10 against the pre-fix bundle, all 143 records, ten widths, both themes: 112 overflowing
 * at every width but 768, where the record page is single-column and the rail has gone, so the one
 * column is briefly wider than the longest address in the corpus and the defect hides.)
 *
 * A measurement that looks exhaustive because of its sample COUNT, while never varying the
 * dimension that actually differs between records, is this codebase's recurring failure. So the
 * dimension varied here is the RECORD, the records are chosen for the property that broke rather
 * than at random, and the file says below exactly which records it does not open.
 *
 * WHAT IS COVERED
 *   · `/o/:id` — the opportunity page — for the deliberately chosen sample listed in
 *     `chooseSample()`: the longest address the page can print (from whichever field it comes),
 *     the longest of each individual address field, the longest programme name, the longest funder
 *     name, the longest summary, the disputed record, the stale-mirror record, a club record, the
 *     blocked-host record, and eight spread evenly through the corpus by id.
 *   · at 320, 360, 390, 768, 1024, 1280 and 1440 — the widths `responsive.test.ts` names — in BOTH
 *     themes, `data-theme` set explicitly rather than left to the runner's colour scheme.
 *   · against the SHIPPED corpus (`data/seed/*.json`, 143 records, canonical ids), booted the way
 *     `shippedSeed.spec.ts` boots it. That is the corpus a `docker compose up` produces and the one
 *     the defect was measured on. The fixture corpus on 3131 holds 150 publishable records built
 *     from the same captures, but it carries only machine tags (`tier:`, `source:`, `key:`), so
 *     "the disputed one" and "the club one" cannot be asked for there at all.
 *
 * WHAT IS NOT COVERED, deliberately
 *   · The other 128 records, by default. The sample comes to 15 of the 143 on today's corpus (a
 *     derived number, not a fixed one: several of the extremes are the same record). A full
 *     crossing is 143 loads and 2,002 measurements, and Playwright reported it at 2.7m against
 *     35s for the sample on the machine this was written on;
 *     `RESPONSIVE_ALL=1 npx playwright test e2e/responsive.spec.ts` runs exactly that. The default
 *     is the sample because this defect class is a property of a record's CONTENT and the extremes
 *     of that content are enumerable; but "the sample passed" is a weaker sentence than "the
 *     corpus passed", and this line is here so nobody reads the first as the second.
 *   · Every route except `/o/:id`. Browse, calendar, watchlist, applications, sources, admin and
 *     the inbox are held by the four structural rules in `responsive.test.ts`, which are checked
 *     against the stylesheet's text and not against a rendering. A `<pre>` or an inline style on
 *     one of those pages would still get past both files.
 *   · Anything but Chromium: this project defines no other browser project.
 *   · Zoom, and the `text-size-adjust`/user-font-size axis. A 320px page at 200% zoom is a 160px
 *     page, and nothing here looks at it.
 */
import { rmSync } from 'node:fs';
import { expect, test, type BrowserContext } from '@playwright/test';
import { armRenderedHoleSweep, expectNoRenderedHoles } from './renderedHoles.js';
import {
  bootShippedServer,
  bootstrapAdmin,
  bootstrapTokenFrom,
  OPERATOR_EMAIL,
  OPERATOR_PASSWORD,
  type BootedServer,
} from './shippedSeed.js';

/**
 * A port and a DATA_DIR of this file's own, for the reason `bootShippedServer` refuses to share
 * one: two servers answering the same `/api/health` is a suite that measures whichever process
 * happened to be listening. 3134 continues the contiguous block that starts at `E2E_PORT` (3131)
 * and runs through `shippedSeed.ts`'s 3132 and 3133; the directory nests inside the gitignored
 * `e2e/.tmp/`, which `seed.ts` wipes before any spec starts.
 */
const RESPONSIVE_PORT = 3134;
const RESPONSIVE_BASE_URL = `http://127.0.0.1:${RESPONSIVE_PORT}`;
const RESPONSIVE_DATA_DIR = 'e2e/.tmp/responsive';

/**
 * The widths `packages/web/src/test/responsive.test.ts` names, and therefore the widths this file
 * is obliged to measure. 320 is the narrowest supported window; the rest are the common phone,
 * tablet and desktop stops the shell's breakpoints sit between.
 */
const WIDTHS = [320, 360, 390, 768, 1024, 1280, 1440] as const;

/**
 * Both themes, set explicitly. `tokens.css` switches on `prefers-color-scheme` OR a `data-theme`
 * attribute, and a run that left the theme to the runner would measure one of them twice and
 * silently never measure the other.
 */
const THEMES = ['light', 'dark'] as const;

/** Tall enough that a record page's vertical scrollbar is the normal case, as it is for a reader. */
const VIEWPORT_HEIGHT = 900;

/** How many records to take from across the corpus in addition to the extremes. */
const SPREAD_SAMPLES = 8;

/** The opt-in full crossing. Off by default; see WHAT IS NOT COVERED above. */
const SAMPLE_ALL = process.env.RESPONSIVE_ALL === '1';

// ---------------------------------------------------------------------------------------------
// The corpus, as `GET /api/programs` serialises it. Declared locally and narrowly: `e2e/` may not
// import from `packages/web`, and only these fields decide which records are worth opening.
// ---------------------------------------------------------------------------------------------

interface BrowseProgram {
  id: string;
  name: string;
  summary: string;
  tags?: string[];
  applyUrl?: string;
  aiPolicy: { url?: string };
  trust: {
    sourceUrl: string;
    contentHash: string;
    disputed?: { claims: Array<{ claim: string; sourceUrl: string }> };
    staleMirrorWarning?: string;
  };
}

interface BrowseRow {
  program: BrowseProgram;
  funderName: string;
}

interface BrowseResponse {
  rows: BrowseRow[];
  total: number;
}

/**
 * Every address the opportunity page can print as visible text for this record.
 *
 * All four fields, not just `trust.sourceUrl`, because the record that actually broke the page was
 * not the one with the longest source URL: `/o/arrl-cat-irarc-memorial-joseph-p-rubino-wa4mmd-`
 * `scholarship` has a 44-character source URL and a 73-character `aiPolicy.url`, and it was the
 * `aiPolicy.url` — 497px of unbreakable text in a 248px aside — that took the document to 1543px
 * in a 1440px window. A sample chosen on `trust.sourceUrl` alone would have picked a different,
 * passing record and reported a clean sweep.
 *
 * `ProvenanceTable`'s addresses are deliberately absent: they arrive from the detail endpoint
 * rather than this payload, and they sit inside `.table-wrap`, which scrolls instead of the page.
 */
function printedAddresses(row: BrowseRow): string[] {
  const { trust, aiPolicy, applyUrl } = row.program;
  return [
    trust.sourceUrl,
    aiPolicy.url,
    applyUrl,
    ...(trust.disputed?.claims ?? []).map((claim) => claim.sourceUrl),
  ].filter((url): url is string => typeof url === 'string' && url !== '');
}

function longestAddress(row: BrowseRow): string {
  return printedAddresses(row).reduce((longest, url) => (url.length > longest.length ? url : longest), '');
}

interface Pick {
  id: string;
  /** Why this record is in the sample, printed with any failure it produces. */
  why: string;
}

/**
 * The sample, chosen from the corpus rather than transcribed.
 *
 * Every entry is derived at run time from what the records actually contain, so a re-captured
 * corpus moves the sample with it instead of leaving this file pointed at ids that no longer
 * describe extremes. The order matters only in that the first reason a record qualifies for is the
 * one reported for it.
 */
function chooseSample(rows: readonly BrowseRow[]): Pick[] {
  const picks: Pick[] = [];
  const take = (why: string, row: BrowseRow | undefined): void => {
    if (row !== undefined) picks.push({ id: row.program.id, why });
  };
  const longestBy = (measure: (row: BrowseRow) => number): BrowseRow | undefined =>
    rows.reduce<BrowseRow | undefined>(
      (best, row) => (best === undefined || measure(row) > measure(best) ? row : best),
      undefined,
    );

  take('the longest address this page can print, from any field', longestBy((r) => longestAddress(r).length));
  take('the longest trust.sourceUrl', longestBy((r) => r.program.trust.sourceUrl.length));
  take('the longest aiPolicy.url', longestBy((r) => (r.program.aiPolicy.url ?? '').length));
  take('the longest applyUrl', longestBy((r) => (r.program.applyUrl ?? '').length));
  take('the longest programme name', longestBy((r) => r.program.name.length));
  take('the longest funder name', longestBy((r) => r.funderName.length));
  // The control: the longest PROSE on any record. Prose has spaces in it, so it should never floor
  // anything — and a failure here would mean the defect is not the one this file is about.
  take('the longest summary — prose, the control', longestBy((r) => r.program.summary.length));
  take(
    'the disputed record — DisputedPanel prints one address per claim',
    rows.find((r) => r.program.trust.disputed !== undefined),
  );
  take(
    'the stale-mirror record — an honesty banner above the fold',
    rows.find((r) => r.program.trust.staleMirrorWarning !== undefined),
  );
  take('a club record', rows.find((r) => (r.program.tags ?? []).includes('club')));
  take(
    'the blocked-host record — SourceLink refuses it and prints the address as text instead',
    rows.find((r) => (r.program.tags ?? []).includes('blocklisted')),
  );

  // …and a handful from across the rest, spread by position in the id-sorted corpus rather than
  // drawn randomly: a random sample that fails is a sample nobody can re-run.
  const byId = [...rows].sort((a, b) => a.program.id.localeCompare(b.program.id));
  for (let i = 0; i < SPREAD_SAMPLES; i += 1) {
    const index = Math.floor(((i + 0.5) * byId.length) / SPREAD_SAMPLES);
    take(`spread ${String(i + 1)}/${String(SPREAD_SAMPLES)} through the corpus by id`, byId[index]);
  }

  const seen = new Set<string>();
  return picks.filter((pick) => (seen.has(pick.id) ? false : (seen.add(pick.id), true)));
}

// ---------------------------------------------------------------------------------------------
// The three things this file does inside the page. Typed by hand because the ROOT tsconfig ships
// no `dom` lib and `npm run typecheck` covers `e2e/` — the same wall `flow.spec.ts`'s
// `readClipboard` documents. Narrow shapes rather than `any`, so a misspelt property is still a
// compile error.
// ---------------------------------------------------------------------------------------------

function setTheme(theme: string): void {
  const { document } = globalThis as unknown as {
    document: { documentElement: { setAttribute(name: string, value: string): void } };
  };
  document.documentElement.setAttribute('data-theme', theme);
}

/** Two frames, so a viewport change has been laid out before anything reads a width off it. */
function nextFrames(): Promise<void> {
  const { requestAnimationFrame } = globalThis as unknown as {
    requestAnimationFrame: (callback: () => void) => void;
  };
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        resolve();
      });
    });
  });
}

interface PageMeasurement {
  scrollWidth: number;
  clientWidth: number;
  /** The element sticking out furthest, when one is. Named so a failure says WHAT overflowed. */
  widest: string | null;
}

function measurePage(): PageMeasurement {
  interface Rect {
    right: number;
    width: number;
  }
  interface El {
    tagName: string;
    className: unknown;
    textContent: string | null;
    getBoundingClientRect(): Rect;
  }
  const { document } = globalThis as unknown as {
    document: {
      documentElement: { scrollWidth: number; clientWidth: number };
      querySelectorAll(selector: string): ArrayLike<El>;
    };
  };
  const root = document.documentElement;
  const measurement: PageMeasurement = {
    scrollWidth: root.scrollWidth,
    clientWidth: root.clientWidth,
    widest: null,
  };
  if (measurement.scrollWidth <= measurement.clientWidth) return measurement;

  // Only when something IS wrong: walking every element is not free, and the answer is only
  // interesting inside a failure message.
  let furthest = measurement.clientWidth;
  const all = document.querySelectorAll('body *');
  for (let i = 0; i < all.length; i += 1) {
    const element = all[i];
    const rect = element.getBoundingClientRect();
    if (rect.right <= furthest) continue;
    furthest = rect.right;
    const className = typeof element.className === 'string' ? element.className : '';
    const text = (element.textContent ?? '').trim().slice(0, 60);
    measurement.widest =
      `<${element.tagName.toLowerCase()} class="${className}"> ` +
      `${String(Math.round(rect.width))}px wide, right edge at ${String(Math.round(rect.right))}px: ` +
      `"${text}"`;
  }
  return measurement;
}

// ---------------------------------------------------------------------------------------------
// One measurement pass in `beforeAll`, several assertions over what it collected.
//
// Not one test per record: Playwright collects tests synchronously at import time, and which
// records are worth opening is not known until the corpus has been read out of a server that does
// not exist yet. Measuring once and asserting many times also keeps the whole sweep to one boot
// and one page — and makes a failure list every offending (record, width, theme) at once rather
// than stopping at the first.
// ---------------------------------------------------------------------------------------------

interface Sample extends Pick, PageMeasurement {
  width: number;
  theme: string;
}

let server: BootedServer | undefined;
let context: BrowserContext | undefined;
let sample: Pick[] = [];
let measurements: Sample[] = [];
let corpus: BrowseRow[] = [];

test.beforeAll(async ({ browser }) => {
  test.setTimeout(SAMPLE_ALL ? 900_000 : 240_000);

  // A first boot every time: `importSeedIfEmpty` only does anything to an empty DATA_DIR, and the
  // one-time bootstrap token is only printed while the users table is empty.
  rmSync(RESPONSIVE_DATA_DIR, { recursive: true, force: true });
  server = await bootShippedServer({ port: RESPONSIVE_PORT, dataDir: RESPONSIVE_DATA_DIR });
  await bootstrapAdmin(RESPONSIVE_BASE_URL, await bootstrapTokenFrom(server));

  context = await browser.newContext({
    baseURL: RESPONSIVE_BASE_URL,
    viewport: { width: WIDTHS[WIDTHS.length - 1] ?? 1440, height: VIEWPORT_HEIGHT },
  });
  // This file's pages come from a context it opens in `beforeAll`, not from the `page` fixture, so
  // the sweep is armed on the context rather than installed per test. See e2e/renderedHoles.ts.
  await armRenderedHoleSweep(context);

  // Signed in over the API rather than through the form. The sign-in SCREEN is `flow.spec.ts`'s
  // subject; here it is a precondition, and 16 page loads should not each wait on a form.
  const login = await context.request.post('/api/auth/login', {
    data: { email: OPERATOR_EMAIL, password: OPERATOR_PASSWORD },
  });
  expect(login.status(), await login.text()).toBe(200);

  const listed = await context.request.get('/api/programs?pageSize=500');
  expect(listed.status(), await listed.text()).toBe(200);
  const body = (await listed.json()) as BrowseResponse;
  corpus = body.rows;
  // `pageSize=500` is above the corpus's size, so one request is the whole of it — asserted rather
  // than assumed, because a sample drawn from page 1 of 8 is exactly the blindness this file is
  // about.
  expect(corpus.length, 'the whole corpus must arrive in one page for the sample to be drawn from it').toBe(
    body.total,
  );

  sample = SAMPLE_ALL
    ? corpus.map((row) => ({ id: row.program.id, why: 'RESPONSIVE_ALL=1: the whole corpus' }))
    : chooseSample(corpus);

  const page = await context.newPage();
  for (const pick of sample) {
    await page.goto(`/o/${encodeURIComponent(pick.id)}`, { waitUntil: 'domcontentloaded' });
    // The record's own `<h1>`: the page is a React shell that answers 200 before it has fetched
    // anything, and measuring a spinner would pass at every width for the wrong reason.
    await page.getByRole('heading', { level: 1 }).first().waitFor();
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
      for (const theme of THEMES) {
        await page.evaluate(setTheme, theme);
        await page.evaluate(nextFrames);
        measurements.push({ ...pick, width, theme, ...(await page.evaluate(measurePage)) });
      }
    }
  }
  // Every opportunity page in the sample, at every width, in both themes — read for holes before
  // the one page this sweep uses is thrown away.
  await expectNoRenderedHoles(page);
  await page.close();
});

test.afterAll(async () => {
  await context?.close();
  await server?.stop();
});

test('the sweep really ran, over the corpus and the sample it claims', () => {
  // Each of these would be silently satisfied by a run that measured nothing.
  expect(corpus.length).toBeGreaterThanOrEqual(100);
  expect(sample.length).toBeGreaterThanOrEqual(SAMPLE_ALL ? corpus.length : 12);
  expect(measurements.length).toBe(sample.length * WIDTHS.length * THEMES.length);
  expect(new Set(measurements.map((m) => m.width))).toEqual(new Set(WIDTHS));
  expect(new Set(measurements.map((m) => m.theme))).toEqual(new Set(THEMES));
});

test('the sample is the adversarial one this file describes, not a handful of records', () => {
  const sampled = new Set(sample.map((pick) => pick.id));
  const inSample = corpus.filter((row) => sampled.has(row.program.id));
  const longestInCorpus = corpus.map(longestAddress).sort((a, b) => b.length - a.length)[0] ?? '';
  const longestInSample = inSample.map(longestAddress).sort((a, b) => b.length - a.length)[0] ?? '';

  expect(
    longestInSample,
    'the sample must contain the corpus\'s longest printed address — that address IS the defect',
  ).toBe(longestInCorpus);

  // If the corpus ever stops holding a long unbreakable address, every assertion below it passes
  // for a reason that has nothing to do with the fix. Say so instead.
  expect(
    longestInCorpus.length,
    'no address in this corpus is long enough to floor a 320px page, so a green run here proves ' +
      'nothing about the defect this file exists to catch. Re-check what the corpus now holds.',
  ).toBeGreaterThanOrEqual(60);

  if (SAMPLE_ALL) return;
  // The shapes named in the header, each of which renders a surface the extremes do not.
  expect(inSample.some((row) => row.program.trust.disputed !== undefined)).toBe(true);
  expect(inSample.some((row) => row.program.trust.staleMirrorWarning !== undefined)).toBe(true);
  expect(inSample.some((row) => (row.program.tags ?? []).includes('club'))).toBe(true);
  expect(inSample.some((row) => (row.program.tags ?? []).includes('blocklisted'))).toBe(true);
});

test('no sampled record scrolls the page sideways, at any width, in either theme', () => {
  const offenders = measurements
    .filter((m) => m.scrollWidth > m.width)
    .map(
      (m) =>
        `/o/${m.id} @ ${String(m.width)}px ${m.theme}: document is ${String(m.scrollWidth)}px ` +
        `(${m.why}) — widest: ${m.widest ?? 'unknown'}`,
    );
  expect(offenders).toEqual([]);
});

test('every measurement was taken at the width it says it was, and by the stricter comparison too', () => {
  // `clientWidth` is the laid-out viewport. If a resize had not landed, it would disagree with the
  // width the measurement is filed under and every comparison above would be against the wrong
  // number.
  const wrongWidth = measurements
    .filter((m) => m.clientWidth !== m.width)
    .map((m) => `/o/${m.id} @ ${String(m.width)}px ${m.theme}: clientWidth ${String(m.clientWidth)}`);
  expect(wrongWidth).toEqual([]);

  // Headless Chromium draws overlay scrollbars, so `clientWidth` equals the viewport exactly and
  // this is the same assertion as the one above it — MEASURED, 2026-08-10, at all seven widths.
  // It is written out anyway: under classic scrollbars the viewport is 15px wider than the layout
  // box, and `scrollWidth <= viewport` would then pass a page that really does scroll sideways.
  const scrolling = measurements
    .filter((m) => m.scrollWidth > m.clientWidth)
    .map(
      (m) =>
        `/o/${m.id} @ ${String(m.width)}px ${m.theme}: ${String(m.scrollWidth)}px inside ` +
        `${String(m.clientWidth)}px — widest: ${m.widest ?? 'unknown'}`,
    );
  expect(scrolling).toEqual([]);
});
