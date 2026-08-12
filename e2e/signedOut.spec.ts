/**
 * THE THREE SIGNED-OUT SCREENS, MEASURED: sign in, first-run setup and enrolment.
 *
 * WHY THIS FILE EXISTS BESIDE `responsive.spec.ts`. That file measures `/o/:id` and says so at
 * length — "every route except `/o/:id`" is in its WHAT IS NOT COVERED list, held only by the four
 * structural rules in `packages/web/src/test/responsive.test.ts`, which read the stylesheet's text
 * and never a rendering. The signed-out page is the one route in that gap that a self-hoster
 * cannot avoid: it is the FIRST screen a fresh install shows, before there is an account, and
 * until this file existed nothing had ever measured a pixel of it.
 *
 * It was worth measuring. The owner reported three faults on the first-run screen and all three
 * were real:
 *
 *   · the help text touched the input above it — measured here at 390px before the fix: the hint's
 *     top edge was 4px ABOVE the bottom edge of the control it explains, because `HINT` carried
 *     `marginTop: calc(-1 * var(--s-3))`;
 *   · the panel could not be widened, because `maxWidth: 380` was an INLINE STYLE on the `main`
 *     element and no media query can reach one: 380px at 320px and 380px at 1920px, with the help
 *     text at 43.5 characters a line on a desktop;
 *   · and the mobile rendering had never been looked at, which is where the 35px text inputs and
 *     the card sitting flush on the viewport edge came from.
 *
 * WHAT IS MEASURED, AND WHAT IS ASSERTED
 *   · all three screens, at 320, 360, 390, 480, 481, 768, 1024, 1440 and 1920, in BOTH themes with
 *     `data-theme` set explicitly rather than left to the runner's colour scheme. 480 and 481 are
 *     the two sides of the one breakpoint this design has, so the claim that the reading width
 *     does not collapse across it is a measurement rather than an assertion;
 *   · and all three again at 320 and 390 under an emulated COARSE POINTER, which is a different
 *     rendering — `pointer: coarse` is what carries the 44px touch floor, and a run that never
 *     emulates a thumb measures the desktop twice.
 *   · The page never scrolls sideways (the repo-wide contract, restated for these routes).
 *   · A hint never touches its input, and one field is further from the next than a control is
 *     from its own explanation.
 *   · The help text's measure, in characters — the number the panel's width is derived from.
 *   · Every touch target's height under a coarse pointer.
 *
 * WHAT IS NOT COVERED, deliberately
 *   · Chromium only: this project defines no other browser project.
 *   · The gate's "could not check" notice, reachable only by making a server call fail at a chosen
 *     moment, which is `FirstRun.test.tsx`'s job; it renders inside the same panel with the same
 *     classes as the modes below.
 *
 *     THE STRANDED FIRST-RUN MODE WAS NAMED HERE TOO AND IS NOT ANY MORE (2026-08-11). It was
 *     `Administrator created` — the account made, the starter profile write that followed it
 *     failed, the form replaced by an alert. First-run setup stopped asking for a callsign, so it
 *     stopped writing a starter profile, so there is no second call left to fail: the mode is
 *     deleted from `routes/FirstRun.tsx` rather than merely hard to reach. Listing it would be
 *     claiming coverage was owed for a screen that cannot be drawn. The a11y audit of it went in
 *     the same round, with the same reasoning, in `packages/web/src/test/a11y.test.tsx`.
 *   · Zoom, and the user-font-size axis. A 320px page at 200% zoom is a 160px page.
 */
import { rmSync } from 'node:fs';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
  bootShippedServer,
  bootstrapAdmin,
  bootstrapTokenFrom,
  type BootedServer,
} from './shippedSeed.js';

/**
 * A port and a DATA_DIR of this file's own, for the reason `bootShippedServer` refuses to share
 * one. 3135 continues the contiguous block that starts at `E2E_PORT` (3131) and runs through
 * `shippedSeed.ts`'s 3132 and 3133 and `responsive.spec.ts`'s 3134; the directory nests inside the
 * gitignored `e2e/.tmp/`, which `seed.ts` wipes before any spec starts.
 */
const PORT = 3135;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DATA_DIR = 'e2e/.tmp/signed-out';

/** The seven widths the responsive contract names, plus the two sides of this design's breakpoint. */
const WIDTHS = [320, 360, 390, 480, 481, 768, 1024, 1440, 1920] as const;

/** The two widths worth re-measuring with a thumb; the floor is a pointer rule, not a width rule. */
const TOUCH_WIDTHS = [320, 390] as const;

const THEMES = ['light', 'dark'] as const;

const VIEWPORT_HEIGHT = 900;

/** `randomBytes(24).toString('hex')` — the shape `auth/bootstrap.ts` prints, at its real length. */
const TOKEN_SHAPE = 'a1b2c3d4'.repeat(6);

/** The floor `tokens.css` states as `--tap-min`, restated here because e2e may not import from web. */
const TAP_MIN_PX = 44;

// ---------------------------------------------------------------------------------------------
// The measurement, run inside the page. Typed by hand because the ROOT tsconfig ships no `dom`
// lib and `npm run typecheck` covers `e2e/` — the same wall `responsive.spec.ts` documents.
// ---------------------------------------------------------------------------------------------

interface HintMeasurement {
  id: string;
  /** Vertical distance from the bottom of the control this hint describes to the top of the hint. */
  gapAbove: number;
  /** The longest rendered line, in `0`-widths of this element's own font: its measure. */
  measureCh: number;
  /** What the box would ALLOW, which is where the cap shows up. */
  boxCh: number;
}

interface TargetMeasurement {
  what: string;
  height: number;
}

interface PageMeasurement {
  scrollWidth: number;
  clientWidth: number;
  panelWidth: number;
  panelLeft: number;
  hints: HintMeasurement[];
  /** One entry per pair of adjacent fields: the distance between them. */
  fieldGaps: number[];
  targets: TargetMeasurement[];
  /** Whether the whole 48-character token is in view, or null when this screen has no such field. */
  tokenFits: boolean | null;
  /** The element sticking out furthest, when one is. Named so a failure says WHAT overflowed. */
  widest: string | null;
}

function measureSignedOut(): PageMeasurement {
  interface Rect {
    top: number;
    bottom: number;
    left: number;
    right: number;
    width: number;
    height: number;
  }
  interface El {
    id: string;
    tagName: string;
    className: unknown;
    textContent: string | null;
    scrollWidth: number;
    clientWidth: number;
    getBoundingClientRect(): Rect;
    getAttribute(name: string): string | null;
    appendChild(child: El): void;
    remove(): void;
    style: { cssText: string };
    nextElementSibling: El | null;
    querySelectorAll(selector: string): ArrayLike<El>;
  }
  interface Range {
    selectNodeContents(node: El): void;
    getClientRects(): ArrayLike<Rect>;
  }
  const { document } = globalThis as unknown as {
    document: {
      documentElement: { scrollWidth: number; clientWidth: number };
      createElement(tag: string): El;
      createRange(): Range;
      querySelector(selector: string): El | null;
      querySelectorAll(selector: string): ArrayLike<El>;
    };
  };
  const list = (nodes: ArrayLike<El>): El[] => Array.prototype.slice.call(nodes) as El[];
  const round = (n: number): number => Math.round(n * 10) / 10;

  /** The width of one `0` in an element's own font: the CSS `ch` unit, measured rather than assumed. */
  const chWidth = (el: El): number => {
    const probe = document.createElement('span');
    probe.style.cssText = 'display:inline-block;width:1ch;height:0;';
    el.appendChild(probe);
    const width = probe.getBoundingClientRect().width;
    probe.remove();
    return width;
  };

  /**
   * The widest RENDERED line of an element's text.
   *
   * A Range's client rects, grouped by top edge — one line can produce several rects when it holds
   * an inline `<code>`, and the element's own box width is the cap rather than the measure.
   */
  const widestLine = (el: El): number => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const lines = new Map<number, { left: number; right: number }>();
    for (const rect of list(range.getClientRects() as unknown as ArrayLike<El>) as unknown as Rect[]) {
      if (rect.width <= 0.5 || rect.height <= 0.5) continue;
      const key = Math.round(rect.top);
      let bucket = key;
      for (const existing of lines.keys()) if (Math.abs(existing - key) <= 3) bucket = existing;
      const previous = lines.get(bucket) ?? { left: rect.left, right: rect.right };
      lines.set(bucket, {
        left: Math.min(previous.left, rect.left),
        right: Math.max(previous.right, rect.right),
      });
    }
    let widest = 0;
    for (const line of lines.values()) widest = Math.max(widest, line.right - line.left);
    return widest;
  };

  const panel = document.querySelector('main#main');
  const panelRect = panel?.getBoundingClientRect();

  const hints = list(document.querySelectorAll('.signed-out-hint')).map((hint) => {
    const described = document.querySelector(`[aria-describedby~="${hint.id}"]`);
    const ch = chWidth(hint);
    const rect = hint.getBoundingClientRect();
    return {
      id: hint.id,
      gapAbove: round(rect.top - (described?.getBoundingClientRect().bottom ?? rect.top)),
      measureCh: ch > 0 ? round(widestLine(hint) / ch) : 0,
      boxCh: ch > 0 ? round(rect.width / ch) : 0,
    };
  });

  // The distance between one field and the next: from the lowest edge of everything in the first
  // to the top of the second. Measured from the rendered boxes rather than read off the CSS, since
  // what a gap resolves to is the whole question.
  const fields = list(document.querySelectorAll('.signed-out-field'));
  const fieldGaps: number[] = [];
  for (let i = 1; i < fields.length; i += 1) {
    const previous = fields[i - 1]?.getBoundingClientRect();
    const current = fields[i]?.getBoundingClientRect();
    if (previous !== undefined && current !== undefined) {
      fieldGaps.push(round(current.top - previous.bottom));
    }
  }

  const targets = list(document.querySelectorAll('main#main button, main#main input')).map(
    (el) => ({
      what: `${el.tagName.toLowerCase()}${el.id === '' ? '' : `#${el.id}`}${
        el.id === '' ? ` "${(el.textContent ?? '').trim().slice(0, 30)}"` : ''
      }`,
      height: round(el.getBoundingClientRect().height),
    }),
  );

  const tokenField = document.querySelector('#first-run-token');

  const measurement: PageMeasurement = {
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    panelWidth: round(panelRect?.width ?? 0),
    panelLeft: round(panelRect?.left ?? 0),
    hints,
    fieldGaps,
    targets,
    // An input whose value is wider than its box scrolls within itself, and says so this way.
    tokenFits: tokenField === null ? null : tokenField.scrollWidth <= tokenField.clientWidth,
    widest: null,
  };

  if (measurement.scrollWidth > measurement.clientWidth) {
    let furthest = measurement.clientWidth;
    for (const element of list(document.querySelectorAll('body *'))) {
      const rect = element.getBoundingClientRect();
      if (rect.right <= furthest) continue;
      furthest = rect.right;
      const className = typeof element.className === 'string' ? element.className : '';
      measurement.widest =
        `<${element.tagName.toLowerCase()} class="${className}"> ` +
        `${String(Math.round(rect.width))}px wide, right edge at ${String(Math.round(rect.right))}px`;
    }
  }

  return measurement;
}

function setTheme(theme: string): void {
  const { document } = globalThis as unknown as {
    document: { documentElement: { setAttribute(name: string, value: string): void } };
  };
  document.documentElement.setAttribute('data-theme', theme);
}

function isCoarsePointer(): boolean {
  const { matchMedia } = globalThis as unknown as {
    matchMedia: (query: string) => { matches: boolean };
  };
  return matchMedia('(pointer: coarse)').matches;
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

// ---------------------------------------------------------------------------------------------
// One measurement pass in `beforeAll`, several assertions over what it collected — the shape
// `responsive.spec.ts` explains: it keeps the whole sweep to one boot, and it makes a failure list
// every offending (screen, width, theme) at once rather than stopping at the first.
// ---------------------------------------------------------------------------------------------

type Screen = 'first-run' | 'sign-in' | 'enrol';

interface Sample extends PageMeasurement {
  screen: Screen;
  width: number;
  theme: string;
  coarse: boolean;
}

let server: BootedServer | undefined;
let context: BrowserContext | undefined;
const measurements: Sample[] = [];

async function sweep(page: Page, screen: Screen, coarse: boolean, widths: readonly number[]): Promise<void> {
  for (const width of widths) {
    await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
    for (const theme of THEMES) {
      await page.evaluate(setTheme, theme);
      await page.evaluate(nextFrames);
      measurements.push({
        screen,
        width,
        theme,
        coarse,
        ...(await page.evaluate(measureSignedOut)),
      });
    }
  }
}

/**
 * The coarse-pointer pass takes a FRESH CONTEXT PER WIDTH and never `setViewportSize`.
 *
 * With `isMobile` on, resizing an existing context re-applies device metrics, and one sample in
 * four came back with `matchMedia('(pointer: coarse)')` false after a resize — i.e. measured the
 * desktop rendering and filed it under touch. Each pass asserts the media query it claims.
 */
async function touchSweep(
  browser: Browser,
  screen: Screen,
  reach: (page: Page) => Promise<void>,
): Promise<void> {
  for (const width of TOUCH_WIDTHS) {
    const touch = await browser.newContext({
      baseURL: BASE_URL,
      viewport: { width, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    const page = await touch.newPage();
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await reach(page);
    expect(await page.evaluate(isCoarsePointer), `${screen} at ${String(width)}px`).toBe(true);
    for (const theme of THEMES) {
      await page.evaluate(setTheme, theme);
      await page.evaluate(nextFrames);
      measurements.push({
        screen,
        width,
        theme,
        coarse: true,
        ...(await page.evaluate(measureSignedOut)),
      });
    }
    await page.close();
    await touch.close();
  }
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);

  // A first boot every time: the first-run screen only exists while the users table is empty, and
  // that is the screen this file is mostly about.
  rmSync(DATA_DIR, { recursive: true, force: true });
  server = await bootShippedServer({ port: PORT, dataDir: DATA_DIR });

  context = await browser.newContext({
    baseURL: BASE_URL,
    viewport: { width: 1440, height: VIEWPORT_HEIGHT },
  });

  // ---- 1. FIRST RUN, on a deployment with no accounts. ----
  const page = await context.newPage();
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: /set up grantspotter/i }).waitFor();
  // A token of the real length in the field, so "does it fit" is a question about the string an
  // operator actually pastes rather than about an empty box.
  await page.getByLabel(/setup token/i).fill(TOKEN_SHAPE);
  await sweep(page, 'first-run', false, WIDTHS);
  await touchSweep(browser, 'first-run', async (touchPage) => {
    await touchPage.getByRole('heading', { name: /set up grantspotter/i }).waitFor();
    await touchPage.getByLabel(/setup token/i).fill(TOKEN_SHAPE);
  });

  // ---- 2. SIGN IN, on the same deployment once an administrator exists. ----
  await bootstrapAdmin(BASE_URL, await bootstrapTokenFrom(server));
  /*
   * FIFTEEN LINES STOOD HERE AND ARE DELETED (2026-08-11): a sign-in as the operator followed by
   * `POST /api/admin/enrollment-codes` to issue a live code, because `GET /api/auth/enrollment-open`
   * was what decided whether the sign-in screen offered the third form at all, and without a code
   * there was no way through to it.
   *
   * All three of those are gone from the server — the admin route is unmounted, the question route
   * is unmounted, and the whole enrollment-code subsystem was retired in migration 095. Registration
   * is open on every deployment, so `Login.tsx` offers "Create an account" unconditionally and the
   * third screen is one press away with no preparation at all. This file never ran this round
   * because that POST answered 404 inside `beforeAll`, which failed the suite before any spec and
   * stranded the eleven tests in the two files ordered after it.
   *
   * Nothing replaces it, and nothing is lost: there was no assertion in it. The two `expect`s it
   * carried were checks that the setup steps had worked, and there are no setup steps left.
   */
  // These three screens are the SIGNED-OUT ones, and a page that still holds a cookie renders the
  // shell instead. This is now belt-and-braces rather than load-bearing: the deleted sign-in above
  // was what put a cookie on this context, and `bootstrapAdmin` uses the process's own `fetch`
  // rather than `context.request`, so the browser never sees that session. Kept because the cost is
  // one call and the failure it prevents — every measurement below taken against the shell — would
  // be baffling.
  await context.clearCookies();

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: /sign in/i }).waitFor();
  await sweep(page, 'sign-in', false, WIDTHS);
  await touchSweep(browser, 'sign-in', (touchPage) =>
    touchPage.getByRole('heading', { name: /sign in/i }).waitFor(),
  );

  // ---- 3. SIGN UP, one press away from the sign-in form. ----
  // The press was "I have an enrollment code" until 2026-08-11; the sign-in screen's aside now
  // reads "No account yet? Create an account", and it is offered to everybody rather than only on
  // deployments that had said yes to a second question.
  await page.setViewportSize({ width: 1440, height: VIEWPORT_HEIGHT });
  await page.getByRole('button', { name: /create an account/i }).click();
  await page.getByRole('heading', { name: /create your account/i }).waitFor();
  await sweep(page, 'enrol', false, WIDTHS);
  await touchSweep(browser, 'enrol', async (touchPage) => {
    await touchPage.getByRole('button', { name: /create an account/i }).tap();
    await touchPage.getByRole('heading', { name: /create your account/i }).waitFor();
  });

  await page.close();
});

test.afterAll(async () => {
  await context?.close();
  await server?.stop();
});

test('the sweep really ran, over all three screens and both pointers', () => {
  // Each of these would be silently satisfied by a run that measured nothing.
  const mouse = measurements.filter((m) => !m.coarse);
  const thumb = measurements.filter((m) => m.coarse);
  expect(mouse.length).toBe(3 * WIDTHS.length * THEMES.length);
  expect(thumb.length).toBe(3 * TOUCH_WIDTHS.length * THEMES.length);
  expect(new Set(measurements.map((m) => m.screen))).toEqual(
    new Set(['first-run', 'sign-in', 'enrol']),
  );
  expect(new Set(mouse.map((m) => m.width))).toEqual(new Set(WIDTHS));
  expect(new Set(measurements.map((m) => m.theme))).toEqual(new Set(THEMES));
  /*
   * And it measured the screens it thinks it did: only the two prose forms carry explanations, and
   * the sign-in box carries none, which is the whole reason their widths differ.
   *
   * BOTH COUNTS FELL BY ONE ON 2026-08-11, and they are re-derived rather than relaxed. First run
   * was THREE: the setup-token hint, the callsign hint and the password hint — account creation
   * stopped asking for a callsign, so the field and its paragraph are gone and it is two. Sign-up
   * was TWO: the enrollment-code hint (what a code is, and that only its hash is stored) and the
   * password hint — there are no codes, so it is one. Verified against the components rather than
   * inferred from a red run: `grep -c signed-out-hint` reports 2 in `routes/FirstRun.tsx`, 1 in
   * `routes/Enroll.tsx`, 0 in `routes/Login.tsx`.
   *
   * They stay EXACT counts, which is the point of them: this assertion is what catches a hint that
   * silently stopped rendering, and `>= 1` would catch nothing. It is also what makes the measure
   * and touching-hint assertions below non-vacuous — they iterate over `m.hints`, and every one of
   * them passes trivially against an empty array.
   */
  expect(measurements.filter((m) => m.screen === 'first-run').every((m) => m.hints.length === 2)).toBe(true);
  expect(measurements.filter((m) => m.screen === 'enrol').every((m) => m.hints.length === 1)).toBe(true);
  expect(measurements.filter((m) => m.screen === 'sign-in').every((m) => m.hints.length === 0)).toBe(true);
});

test('no signed-out screen scrolls the page sideways, at any width, in either theme', () => {
  const offenders = measurements
    .filter((m) => m.scrollWidth > m.width || m.scrollWidth > m.clientWidth)
    .map(
      (m) =>
        `${m.screen} @ ${String(m.width)}px ${m.theme}${m.coarse ? ' (touch)' : ''}: document is ` +
        `${String(m.scrollWidth)}px in a ${String(m.clientWidth)}px viewport — widest: ${m.widest ?? 'unknown'}`,
    );
  expect(offenders).toEqual([]);
});

test('every measurement was taken at the width it says it was', () => {
  // If a resize had not landed, every comparison above would be against the wrong number.
  const wrong = measurements
    .filter((m) => m.clientWidth !== m.width)
    .map((m) => `${m.screen} @ ${String(m.width)}px: clientWidth ${String(m.clientWidth)}`);
  expect(wrong).toEqual([]);
});

test('no hint sits against the input it explains', () => {
  // The reported fault. Before the fix this was -4px at every width, on both prose screens.
  const touching = measurements
    .flatMap((m) => m.hints.map((hint) => ({ ...m, hint })))
    .filter((m) => m.hint.gapAbove < 4)
    .map(
      (m) =>
        `${m.screen} @ ${String(m.width)}px ${m.theme}: ${m.hint.id} is ` +
        `${String(m.hint.gapAbove)}px below its input`,
    );
  expect(touching).toEqual([]);
});

test('a field is further from the next field than it is from its own explanation', () => {
  // Proximity is the only thing telling a reader which paragraph belongs to which control, and it
  // was saying the opposite.
  const backwards = measurements
    .filter((m) => m.hints.length > 0 && m.fieldGaps.length > 0)
    .flatMap((m) => {
      const withinField = Math.max(...m.hints.map((hint) => hint.gapAbove));
      const betweenFields = Math.min(...m.fieldGaps);
      return betweenFields >= withinField * 2
        ? []
        : [
            `${m.screen} @ ${String(m.width)}px ${m.theme}: ${String(betweenFields)}px between ` +
              `fields against ${String(withinField)}px inside one`,
          ];
    });
  expect(backwards).toEqual([]);
});

test('the help text reads at a comfortable measure, and reaches its cap on a desktop', () => {
  const hints = measurements.flatMap((m) => m.hints.map((hint) => ({ ...m, hint })));

  // 66ch is the cap `signedOut.css` states and the number the prose panel's width is derived from.
  // Nothing may exceed it at any width: that is what a cap means.
  const tooWide = hints
    .filter((m) => m.hint.measureCh > 66)
    .map((m) => `${m.screen} @ ${String(m.width)}px: ${m.hint.id} at ${String(m.hint.measureCh)}ch`);
  expect(tooWide).toEqual([]);

  // From 768px up the cap is what binds, not the panel — which is the point of sizing the panel
  // from the measure rather than the other way round. 60ch allows for a longest line that ends a
  // word or two short of the cap.
  const tooNarrowOnDesktop = hints
    .filter((m) => m.width >= 768 && m.hint.measureCh < 60)
    .map((m) => `${m.screen} @ ${String(m.width)}px: ${m.hint.id} at ${String(m.hint.measureCh)}ch`);
  expect(tooNarrowOnDesktop).toEqual([]);

  // And on the narrowest phone there is no width left to give: 320px minus the gutter, the padding
  // and the border is 270px, which is 37 characters of `--fs-200`. The floor is stated so that a
  // future change spending more of a phone's width on frame fails here rather than passing quietly.
  const tooNarrowOnAPhone = hints
    .filter((m) => m.hint.boxCh < 36)
    .map((m) => `${m.screen} @ ${String(m.width)}px: ${m.hint.id} box ${String(m.hint.boxCh)}ch`);
  expect(tooNarrowOnAPhone).toEqual([]);
});

test('the panel is as wide as its contents need and no wider, and is never the whole screen', () => {
  for (const m of measurements) {
    // The gutter: a card whose border sits on the viewport edge reads as the page, not as a card.
    expect(m.panelLeft, `${m.screen} @ ${String(m.width)}px`).toBeGreaterThanOrEqual(8);
    expect(m.panelWidth, `${m.screen} @ ${String(m.width)}px`).toBeLessThanOrEqual(m.width - 16);
  }

  // The two ceilings, where both are reached: 24rem for the two-field sign-in box, 34rem for a
  // form whose fields carry paragraphs. Same wrapper, different objects.
  const at = (screen: Screen, width: number): number =>
    measurements.find((m) => m.screen === screen && m.width === width && !m.coarse)?.panelWidth ?? 0;
  expect(at('sign-in', 1440)).toBe(384);
  expect(at('first-run', 1440)).toBe(544);
  expect(at('enrol', 1440)).toBe(544);
  // …and it is a CEILING: nothing keeps growing with the window.
  expect(at('first-run', 1920)).toBe(at('first-run', 1440));
  expect(at('sign-in', 1920)).toBe(at('sign-in', 1440));
});

test('the breakpoint re-spaces the card without collapsing what can be read', () => {
  // 480 and 481 are the two sides of the one media query in this stylesheet. Below it the panel
  // spends `--s-4` on padding instead of `--s-5`, and the text takes the difference — so the
  // reading width must not FALL as the screen narrows through it.
  const boxAt = (width: number): number =>
    Math.max(
      ...(measurements.find((m) => m.screen === 'first-run' && m.width === width && !m.coarse)
        ?.hints.map((hint) => hint.boxCh) ?? [0]),
    );
  expect(boxAt(480)).toBeGreaterThan(boxAt(481));
});

test('every control clears the 44px touch floor when the pointer is a thumb', () => {
  const thumb = measurements.filter((m) => m.coarse);
  expect(thumb.length).toBeGreaterThan(0);
  const small = thumb
    .flatMap((m) => m.targets.map((target) => ({ ...m, target })))
    .filter((m) => m.target.height < TAP_MIN_PX)
    .map(
      (m) =>
        `${m.screen} @ ${String(m.width)}px ${m.theme}: ${m.target.what} is ` +
        `${String(m.target.height)}px tall`,
    );
  expect(small).toEqual([]);

  // The floor is a pointer rule and not a width rule, so the desktop rendering at the same width
  // is deliberately NOT held to it — base.css's own comment is explicit that a narrow window on a
  // desktop is still a mouse. This asserts the two really are different renderings, because a
  // touch pass that silently ran as a desktop one would pass everything above for the wrong reason.
  const mouseAt320 = measurements.find((m) => m.screen === 'first-run' && m.width === 320 && !m.coarse);
  const thumbAt320 = measurements.find((m) => m.screen === 'first-run' && m.width === 320 && m.coarse);
  const shortest = (m: Sample | undefined): number =>
    Math.min(...(m?.targets.map((target) => target.height) ?? [0]));
  expect(shortest(mouseAt320)).toBeLessThan(TAP_MIN_PX);
  expect(shortest(thumbAt320)).toBeGreaterThanOrEqual(TAP_MIN_PX);
});

test('the setup token is legible in the field an operator pastes it into', () => {
  const tokenScreens = measurements.filter((m) => m.tokenFits !== null);
  expect(tokenScreens.length).toBeGreaterThan(0);

  // From 768px up the whole 48-character token is in view at once, which is what lets an operator
  // check a pasted secret against the one they read out of `<DATA_DIR>/first-run-token.txt`. (This
  // said "the one in the log" until 2026-08-11; the token is not printed there any more.)
  const clipped = tokenScreens
    .filter((m) => m.width >= 768 && m.tokenFits === false)
    .map((m) => `${m.screen} @ ${String(m.width)}px ${m.theme}`);
  expect(clipped).toEqual([]);

  // Below that it scrolls within its own box — which loses nothing, since the token is pasted
  // rather than typed, and is the reason the field is set in `--fs-200` rather than at body size.
  // What it must never do is make the PAGE scroll, which the first assertion in this file covers.
  expect(tokenScreens.some((m) => m.width === 320 && m.tokenFits === false)).toBe(true);
});
