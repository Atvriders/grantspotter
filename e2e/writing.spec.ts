/**
 * THE WRITING DESK, END TO END: pick a programme → choose a template → fill it → see the gaps →
 * analyse the prose → work the fact checklist → copy the AI prompt → be refused an export until a
 * person has confirmed every assertion.
 *
 * This file has two halves, and the split is deliberate.
 *
 * 1. `the writing desk over HTTP` runs TODAY, against `node packages/server/dist/index.js` — the
 *    real built server, the real migrations, the real `content/` corpus loaded by walking up from
 *    the built module's own directory, and the real 703-record seeded database. It needs no SPA,
 *    exactly as `api.spec.ts` needs none, so every property this plan exists for is proved against
 *    the shipped artefact rather than against a source-level mock. Plan 3 Task 14 caught its mount
 *    defect this way; this half is the same instrument pointed at Plan 4's four routers.
 *
 * 2. `the writing desk in a browser` needs the SPA fallback at `/`, which is the LAST statement of
 *    Plan 3 Task 14's `mountRoutes` callback and belongs to Plan 5 Task 17 (RESOLUTIONS R16 + R25).
 *    Plan 4 creates no `api/spa.ts`, adds no `express.static` and no history fallback. So each
 *    browser spec asks the running server what `/` actually answers and SKIPS WITH A REASON when
 *    the fallback is absent — the pattern `flow.spec.ts` established, and for its reason: a
 *    permanently red suite is indistinguishable from a newly red one, and the next agent cannot
 *    tell the expected failure from the regression they just introduced. It is not a hard-coded
 *    skip. The moment `a.use(createSpaMiddleware(webDistRoot()));` is appended at Task 14's
 *    reservation comment, `/` returns `<!doctype html>` and all six run with no edit here.
 *    `flow.spec.ts`'s always-running guard spec — "GET / is in exactly one of the two states this
 *    suite knows about" — is what stops that skip from covering a third, broken state.
 *
 * FOUR DEVIATIONS FROM THE TASK BRIEF, each found by executing it.
 *
 *   a. `page.goto('/o/ardc-grants')` addresses a record the e2e corpus does not contain. `ardc-grants`
 *      is the canonical PROGRAMME ID the overlays bind to (R9) and also the SOURCE id; the ids in
 *      `e2e/seed.ts`'s corpus are minted by the normalizer as `<source>--<key>--<hash>`, so the ARDC
 *      programme is `ardc-grants--apply--…`. The id is therefore looked up by name through
 *      `programIdByName`, as `e2e/helpers.ts` requires of every other spec, and the overlay binding
 *      to the canonical id is asserted separately and directly over HTTP, where it is a fact about
 *      the shipped overlay rather than about the seed.
 *   b. `getByRole('link', { name: /FSU SGA/i })` matches nothing. The playbook's cited source reads
 *      "Florida State University SGA, funding your RSO — one representative campus, read on
 *      2026-08-02". The link is asserted on the text the product actually renders.
 *   c. The brief's `const body = page.getByLabel('Draft');` fails twice over, and both are visible
 *      only from a browser. `getByLabel` matches a substring by default, so it also resolves the
 *      slot form — whose accessible name is "Facts this DRAFT needs" — and dies on strict mode;
 *      `{ exact: true }` is required. And `expect(body).toContainText('[TODO:')` cannot pass
 *      against a controlled `<textarea>` at all: `toContainText` reads `textContent` while React
 *      sets the `value` PROPERTY, so it reads an empty string no matter what the draft says.
 *      `toHaveValue` is the matcher for a form control, and a gap invisible to the assertion that
 *      is supposed to see it is precisely the failure this plan exists to prevent.
 *   d. The brief lists "Modify: none". `packages/server/test/vitestCoverageContract.test.ts` fails
 *      by name for any `*.spec.ts` no vitest project collects, so this file has to be signed into
 *      its `NOT_A_VITEST_FILE` allow-list in the same commit — as `api.spec.ts` and `flow.spec.ts`
 *      already are.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_PASSWORD, programIdByName } from './helpers.js';
import { installRenderedHoleSweep } from './renderedHoles.js';

// Every state every journey below passes through is swept for a rendered `undefined`/`null`/
// `NaN`/`[object Object]`. See e2e/renderedHoles.ts.
installRenderedHoleSweep();

/**
 * The ARDC programme, by name rather than by id — `e2e/seed.ts` mints ids from the source record,
 * so a re-captured fixture changes the hash without changing which programme this is. It is the
 * one record in the corpus whose funder an overlay in this plan is written against and whose
 * `klass` (`ham_grant`) the component layer applies to, which is what makes it the deep link worth
 * driving.
 */
const ARDC_PROGRAM_NAME = 'Apply for a Grant';

/** The canonical programme id the ARDC overlay's frontmatter binds to (RESOLUTIONS R9). */
const ARDC_CANONICAL_ID = 'ardc-grants';

/** Contract copy, spec §10.2. The em dash is U+2014 and this string is asserted byte-for-byte. */
const COPY_PROMPT_LABEL = 'Copy AI Prompt — includes AI-detection avoidance';

const SPA_PENDING =
  "The SPA fallback is not mounted: GET / is still Plan 1's JSON 404 envelope. Plan 5 Task 17 " +
  'appends `a.use(createSpaMiddleware(webDistRoot()));` at Task 14\'s reservation comment in ' +
  'packages/server/src/index.ts, and every browser spec in this file runs from that moment on ' +
  'with no edit here. The HTTP half of this file is not waiting on anything and drives the same ' +
  'server today.';

/**
 * Sentence polarity, transcribed from `packages/web/src/routes/Applications.test.tsx`, which took
 * them from `packages/server/src/prompts/compose.test.ts`. One boundary, now three surfaces: the
 * composed prompt as the SERVER really emits it, and the writing desk as a BROWSER really renders
 * it. Any sentence carrying an evasion or classifier-gaming word must also carry a negation or an
 * exclusion. None of them can match the mandated label, which says "avoidance" and promises
 * nothing.
 */
const EVASION =
  /\b(defeat|defeats|defeating|evade|evades|evading|evasion|bypass|bypasses|fool|fools|trick|tricks|undetectable|beats? the detector|slips? past|sneaks? past|goes? undetected|avoids? detection|pass(es)? as human|reads? as human)\b/i;
const GAMING =
  /\b(synonym|synonyms|typo|typos|homoglyph|homoglyphs|invisible character|invisible characters|zero-width)\b/i;
const NEGATED =
  /\b(not|never|no|none|nothing|excluded|exclude|excludes|cannot|can't|won't|do not|does not|refuse|refuses|instead of|rather than)\b/i;

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function assertNoEvasionPromise(texts: string[], where: string): void {
  for (const text of texts) {
    for (const s of sentences(text)) {
      if (EVASION.test(s) || GAMING.test(s)) expect(s, `${where}: ${s}`).toMatch(NEGATED);
    }
  }
}

// ---------------------------------------------------------------------------
// The DTOs this file reads. Re-declared rather than imported: `packages/web` never imports server
// code and neither does this suite, and a shape asserted against the wire is worth more than one
// borrowed from the module that produced it.
// ---------------------------------------------------------------------------

interface TemplateSummary {
  id: string;
  title: string;
  sources: Array<{ label: string; url: string }>;
}
interface TemplateList {
  components: TemplateSummary[];
  overlays: TemplateSummary[];
  playbooks: TemplateSummary[];
}
interface FilledTemplate {
  templateId: string;
  title: string;
  markdown: string;
  unresolvedSlots: string[];
}
interface Application {
  id: string;
  title: string;
  bodyMarkdown: string;
  programId?: string;
  includeDisclosure: boolean;
}
interface FactItem {
  id: string;
  kind: string;
  text: string;
  origin: 'profile' | 'program' | 'answer' | 'unattributed';
  confirmed: boolean;
  note: string;
  fingerprint: string;
  provenance: string;
  staleConfirmation: boolean;
}
interface Readiness {
  ready: boolean;
  unconfirmed: number;
  openTodos: number;
  items: FactItem[];
}

async function signIn(api: APIRequestContext, email: string, password: string): Promise<void> {
  const res = await api.post('/api/auth/login', { data: { email, password } });
  expect(res.status(), await res.text()).toBe(200);
}

async function json<T>(promise: Promise<import('@playwright/test').APIResponse>): Promise<T> {
  const res = await promise;
  expect(res.status(), `${res.url()} → ${await res.text()}`).toBeLessThan(400);
  return (await res.json()) as T;
}

// ===========================================================================
// 1. THE WRITING DESK OVER HTTP — runs today, against the built server.
// ===========================================================================

test.describe('the writing desk over HTTP', () => {
  test('the four writing routers answer from the built server, with content/ found at runtime', async ({
    request,
  }) => {
    await signIn(request, ADMIN_EMAIL, ADMIN_PASSWORD);

    // A 404 here is the defect Task 17 Step 5 exists to prevent: four `a.use(...)` lines that
    // never reached the one `mountRoutes` callback. It cannot be seen from a source-level test
    // that builds its own express app.
    const library = await json<TemplateList>(request.get('/api/templates?klass=ham_grant'));
    expect(library.components.length).toBeGreaterThanOrEqual(12);
    expect(library.components.map((c) => c.title)).toContain('Need statement');

    // `content/` is located at runtime by walking up from the module URL. In `dist` that walk
    // starts one directory deeper than it does in `src`, so this is the assertion that the shipped
    // layout — not just the checkout — can find the corpus at all.
    const needStatement = await json<{ id: string; body: string }>(
      request.get('/api/templates/need-statement'),
    );
    expect(needStatement.body).toContain('{{');

    // Vocabulary and the consortium picker, both behind the same router. The count is asserted as
    // a floor rather than a number: it has already moved twice in this plan (`report.awardedAmount`
    // in Task 6, `project.awardAmount` in Task 8, 67 today), and a count pinned here would go red
    // for an addition that is exactly what the vocabulary is for. What must hold is the SPLIT —
    // a program-sourced slot is never put to the applicant to type.
    const slots = await json<{
      all: Array<{ path: string; source: string }>;
      userAnswerable: Array<{ path: string }>;
    }>(request.get('/api/templates/slots'));
    expect(slots.all.length).toBeGreaterThanOrEqual(66);
    expect(slots.all.map((s) => s.path)).toContain('club.callsign');
    expect(slots.userAnswerable.length).toBeLessThan(slots.all.length);
    expect(slots.userAnswerable.map((s) => s.path)).not.toContain('funder.applyUrl');
    const mi = await json<{ consortium: { verified: boolean; state: string } | null }>(
      request.get('/api/templates/consortium/MI'),
    );
    expect(mi.consortium?.state).toBe('MI');
    // Ships `verified: false` on all 52 records by design; only `verify-sources` may promote them.
    expect(mi.consortium?.verified).toBe(false);
  });

  test('the Campus SGA playbook is always available, and cites the campus it was read from', async ({
    request,
  }) => {
    await signIn(request, ADMIN_EMAIL, ADMIN_PASSWORD);

    // No programId, no funderId, no klass: nothing here selects it. `alwaysAvailable: true` is the
    // only reason it appears — a quoted `"true"` once read as false and hid the playbook entirely,
    // which is the failure this asserts against rather than a spelling.
    const bare = await json<TemplateList>(request.get('/api/templates'));
    const playbook = bare.playbooks.find((p) => p.id === 'funder-campus-sga');
    expect(playbook?.title).toBe('Campus student government playbook');
    expect(playbook?.sources[0]?.url).toContain('sga.fsu.edu');
    expect(playbook?.sources[0]?.label).toContain('Florida State University SGA');

    // And it is not smuggled in as an overlay: overlays are funder-bound, playbooks are not.
    expect(bare.overlays).toEqual([]);
    const body = await json<{ body: string }>(request.get('/api/templates/funder-campus-sga'));
    expect(body.body).toContain('capital equipment');
  });

  test('an ARDC deep link selects the ARDC overlay, by the canonical id and by the funder', async ({
    request,
  }) => {
    await signIn(request, ADMIN_EMAIL, ADMIN_PASSWORD);

    // THE R9 DRIFT CHECK, over the wire. `selectTemplates` filters with
    // `t.programIds.includes(q.programId)`, so an id that differs by one character returns an
    // empty `overlays` array with no error and no warning, and the funder-specific guidance simply
    // disappears from the writing desk. This asks the shipped overlay directly, so it holds
    // whatever ids a future seed corpus mints.
    const canonical = await json<TemplateList>(
      request.get(`/api/templates?programId=${ARDC_CANONICAL_ID}`),
    );
    expect(canonical.overlays.map((o) => o.id)).toContain('funder-ardc');

    // And the link the product actually builds: `Opportunity.tsx` passes programId, klass and
    // funderId together, and the seeded ARDC record carries the funder id the overlay names.
    const programId = programIdByName(ARDC_PROGRAM_NAME);
    const program = await json<{ program: { id: string; funderId: string; klass: string } }>(
      request.get(`/api/programs/${programId}`),
    );
    const deepLink = await json<TemplateList>(
      request.get(
        `/api/templates?programId=${encodeURIComponent(programId)}&klass=${program.program.klass}&funderId=${program.program.funderId}`,
      ),
    );
    expect(deepLink.overlays[0]?.id).toBe('funder-ardc');
    expect(deepLink.overlays[0]?.title).toContain('ARDC Grants Program');
    expect(deepLink.overlays[0]?.sources.map((s) => s.url)).toContain('https://www.ardc.net/apply/');
  });

  test('a filled template leaves visible gaps, and a gap never becomes a fact to confirm', async ({
    request,
  }) => {
    await signIn(request, ADMIN_EMAIL, ADMIN_PASSWORD);
    const programId = programIdByName(ARDC_PROGRAM_NAME);
    const { program } = await json<{ program: unknown }>(request.get(`/api/programs/${programId}`));

    // Filled with the funder's own record and NOTHING about the applicant: every applicant slot is
    // unknown, which is the state the gap marker exists for.
    const filled = await json<FilledTemplate>(
      request.post('/api/templates/need-statement/fill', { data: { program } }),
    );
    expect(filled.unresolvedSlots).toContain('club.callsign');
    expect(filled.markdown).toContain('[TODO: club.callsign');

    // A gap cannot read as a completed assertion: every marker is bracketed, opens with the word
    // TODO, names its slot and closes before the next one. Nothing between `{{` and `}}` survives
    // as plausible prose.
    expect(filled.markdown).not.toContain('{{');
    for (const marker of filled.markdown.match(/\[TODO:[^\]]*\]/g) ?? []) {
      expect(marker).toMatch(/^\[TODO: [a-z][A-Za-z.]+ — .+\]$/);
    }

    const draft = await json<Application>(
      request.post('/api/applications', { data: { title: 'Need statement draft', programId } }),
    );
    await json<Application>(
      request.patch(`/api/applications/${draft.id}`, { data: { bodyMarkdown: filled.markdown } }),
    );

    const readiness = await json<Readiness>(
      request.get(`/api/applications/${draft.id}/export-readiness`),
    );
    // The gaps block export on their own, counted from the same regex the marker is written with.
    expect(readiness.openTodos).toBe(filled.unresolvedSlots.length);
    expect(readiness.ready).toBe(false);

    // AND NOT ONE OF THEM IS A CHECKLIST ITEM. `e.g. W8UM` and `e.g. 1909` live inside the hint
    // text of an unfilled slot; nobody wrote them, and confirming them would be confirming the
    // tooltip. This has been produced three times in this repository, so it is asserted on the
    // wire rather than in the component that renders it.
    const texts = readiness.items.map((i) => i.text);
    expect(texts).not.toContain('W8UM');
    expect(texts).not.toContain('1909');
    for (const item of readiness.items) {
      expect(filled.markdown).toContain(item.text);
      expect(item.text).not.toContain('TODO');
    }
  });

  test('a confirmation dies when the value it confirms is edited, and export stays shut', async ({
    request,
  }) => {
    await signIn(request, ADMIN_EMAIL, ADMIN_PASSWORD);
    const programId = programIdByName(ARDC_PROGRAM_NAME);
    const draft = await json<Application>(
      request.post('/api/applications', { data: { title: 'Fact checklist draft', programId } }),
    );

    // One sentence, seven checkable specifics, one of which — the apply URL — is a value the
    // funder's own record states.
    const body =
      'W8UM spent $1,450 on one Icom IC-7300 on March 7, 2027. Apply at https://grants.ardc.net.';
    await json<Application>(
      request.patch(`/api/applications/${draft.id}`, { data: { bodyMarkdown: body } }),
    );

    const before = await json<Readiness>(
      request.get(`/api/applications/${draft.id}/export-readiness`),
    );
    expect(before.openTodos).toBe(0);
    expect(before.ready).toBe(false);

    // ORIGIN IS NOT CONFIRMATION. The apply URL matches the funder's published record, and it
    // still blocks export until a person ticks it; its provenance sentence says so in words.
    const fromProgram = before.items.find((i) => i.origin === 'program');
    expect(fromProgram?.text).toBe('https://grants.ardc.net');
    expect(fromProgram?.confirmed).toBe(false);
    expect(fromProgram?.provenance).toMatch(/funder/i);
    expect(before.unconfirmed).toBe(before.items.length);

    const confirmations: Record<string, { confirmed: boolean; note: string; fingerprint: string }> = {};
    for (const item of before.items) {
      confirmations[item.id] = {
        confirmed: true,
        note: 'checked against the funder page',
        fingerprint: item.fingerprint,
      };
    }
    const confirmed = await json<Readiness>(
      request.put(`/api/applications/${draft.id}/facts`, { data: { confirmations } }),
    );
    expect(confirmed).toMatchObject({ ready: true, unconfirmed: 0, openTodos: 0 });

    // THE EDIT THAT USED TO SURVIVE ITS OWN CONFIRMATION. `$1,450` → `$9,999` at identical
    // character width, so every positional id (`${kind}:${start}`) in the draft is unchanged and a
    // confirmation keyed on position would still read as ticked. The fingerprint is a hash of the
    // WORDS, so this one dies with the value it confirmed.
    const edited = body.replace('$1,450', '$9,999');
    expect(edited.length).toBe(body.length);
    await json<Application>(
      request.patch(`/api/applications/${draft.id}`, { data: { bodyMarkdown: edited } }),
    );

    const after = await json<Readiness>(
      request.get(`/api/applications/${draft.id}/export-readiness`),
    );
    const money = after.items.find((i) => i.kind === 'money');
    expect(money?.id).toBe(before.items.find((i) => i.kind === 'money')?.id);
    expect(money?.text).toBe('$9,999');
    expect(money?.confirmed).toBe(false);
    expect(money?.staleConfirmation).toBe(true);
    // The note is kept; only the tick is withdrawn.
    expect(money?.note).toBe('checked against the funder page');
    expect(after.unconfirmed).toBe(1);
    // This is the state `assertExportReady` throws `AppError('conflict')` on — HTTP 409 through
    // Plan 1's errorHandler. Plan 4 mounts no export route, so the 409 itself is pinned by
    // `describe('assertExportReady')` in packages/server/src/api/applications.test.ts; Plan 5's
    // `/exports/draft.docx` and `/exports/packet.zip` owe the same proof over HTTP.
    expect(after.ready).toBe(false);
  });

  test('a fact confirmed at an id the draft has no fact at is refused, not stored', async ({
    request,
  }) => {
    await signIn(request, ADMIN_EMAIL, ADMIN_PASSWORD);
    const draft = await json<Application>(
      request.post('/api/applications', { data: { title: 'Pre-confirmation attempt' } }),
    );
    await json<Application>(
      request.patch(`/api/applications/${draft.id}`, { data: { bodyMarkdown: 'Nothing checkable here.' } }),
    );

    // Storing this would leave a confirmation waiting at that position for whatever text lands
    // there next — a fact pre-confirmed before it was written.
    const res = await request.put(`/api/applications/${draft.id}/facts`, {
      data: { confirmations: { 'money:999': { confirmed: true, note: '' } } },
    });
    expect(res.status()).toBe(422);
    const body = (await res.json()) as {
      error: { code: string; details?: { unknownFactIds?: string[] } };
      requestId: string;
    };
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.details?.unknownFactIds).toEqual(['money:999']);
    expect(body.requestId).toBeTruthy();
  });

  test('the composed prompt is grounded in the funder and promises no detector evasion', async ({
    request,
  }) => {
    await signIn(request, ADMIN_EMAIL, ADMIN_PASSWORD);
    const programId = programIdByName(ARDC_PROGRAM_NAME);
    const { program } = await json<{ program: unknown }>(request.get(`/api/programs/${programId}`));

    const composed = await json<{ prompt: string; label: string; subtitle: string }>(
      request.post('/api/prompts/compose', {
        data: { program, templateId: 'funder-ardc', includeDisclosure: true },
      }),
    );

    // The contract copy, byte-for-byte, from the server that ships it.
    expect(composed.label).toBe(COPY_PROMPT_LABEL);
    expect(composed.subtitle).toContain('Includes: this funder');
    expect(composed.subtitle).toContain('never-invent-a-citation');

    // Grounded in this funder's own words, quoted, rather than in a description of them.
    expect(composed.prompt).toContain('thoroughly edit for clarity, brevity, and accuracy');
    expect(composed.prompt).toMatch(/never invent|do not invent/i);
    expect(composed.prompt.length).toBeGreaterThan(5_000);

    // The single highest-consequence rule, and the honesty boundary around the label.
    assertNoEvasionPromise([composed.prompt, composed.label, composed.subtitle], 'composed prompt');
    expect(composed.prompt).toMatch(/classifier/i);

    // The disclosure sentence is composed from the funder's OWN stance, which is why the endpoint
    // takes the stance and the funder's name rather than a program: a draft can carry a disclosure
    // for a funder that is not in the corpus at all.
    const stance = (program as { aiPolicy?: { stance?: string } }).aiPolicy?.stance ?? 'unaddressed';
    const disclosure = await json<{ sentence: string; note: string; defaultOn: boolean }>(
      request.post('/api/prompts/disclosure', {
        data: { stance, funderName: 'Amateur Radio Digital Communications' },
      }),
    );
    expect(disclosure.sentence).toContain('takes full responsibility for its content');
    expect(disclosure.defaultOn).toBe(true);

    // When the funder REQUIRES disclosure, the sentence says so and names them — the applicant is
    // never left to infer an obligation from a checkbox.
    const required = await json<{ sentence: string }>(
      request.post('/api/prompts/disclosure', {
        data: { stance: 'permitted_with_disclosure', funderName: 'ARDC' },
      }),
    );
    expect(required.sentence).toContain("ARDC's published requirement to disclose the use of AI");
    assertNoEvasionPromise([disclosure.sentence, disclosure.note, required.sentence], 'disclosure');
  });

  test('the prose check reports where a passage is generic, and never scores it', async ({
    request,
  }) => {
    await signIn(request, ADMIN_EMAIL, ADMIN_PASSWORD);
    const generic =
      "In today's rapidly evolving landscape, our organization delves into the transformative " +
      'potential of amateur radio. Furthermore, this comprehensive initiative underscores our ' +
      'unwavering commitment to educate, empower, and inspire learners, ensuring long-term ' +
      'impact for years to come.';
    const specific =
      'W8UM operates from Room 214 of the EECS building at the University of Michigan. Thirty-four ' +
      'licensed members ran 1,208 contacts during Field Day on June 28, 2026, using one Icom ' +
      'IC-7300 bought in 2019.';

    const bad = await json<{
      report: {
        paragraphs: Array<{ verdict: string; stockTransitionHits: string[] }>;
        stockOpenerHits: string[];
        paragraphsWithNoProperNounOrFigure: number[];
      };
      densities: Array<{ styleDensity: number; referentDensity: number }>;
    }>(request.post('/api/prose/analyze', { data: { text: generic } }));

    expect(bad.report.paragraphs[0]?.verdict).toBe('generic');
    expect(bad.report.stockOpenerHits).toContain("In today's rapidly evolving landscape");
    expect(bad.report.paragraphs[0]?.stockTransitionHits).toContain('Furthermore');
    expect(bad.report.paragraphsWithNoProperNounOrFigure).toContain(0);
    expect(bad.densities[0]?.referentDensity).toBe(0);

    const good = await json<{ report: { paragraphs: Array<{ verdict: string }> } }>(
      request.post('/api/prose/analyze', { data: { text: specific } }),
    );
    expect(good.report.paragraphs[0]?.verdict).toBe('specific');

    // No score anywhere in the payload, and no claim about who or what wrote it.
    const raw = JSON.stringify(bad);
    expect(raw).not.toMatch(/"score"|"rating"|aiWritten|likelihood/i);
    expect(raw).not.toMatch(/AI-written|AI-generated|written by (?:an? )?(?:AI|machine)/i);
  });

  test('a draft belongs to one person, and nobody else can read or export it', async ({
    request,
  }) => {
    await signIn(request, ADMIN_EMAIL, ADMIN_PASSWORD);
    const mine = await json<Application>(
      request.post('/api/applications', { data: { title: 'Private draft' } }),
    );

    await request.post('/api/auth/logout');
    const anonymous = await request.get(`/api/applications/${mine.id}`);
    expect(anonymous.status()).toBe(401);
  });
});

// ===========================================================================
// 2. THE WRITING DESK IN A BROWSER — skips with a reason until the SPA is served.
// ===========================================================================

/**
 * Open the app, or skip this spec because Plan 5's SPA middleware is not mounted yet. A JSON 404
 * at `/` is the one permitted state; `flow.spec.ts`'s always-running guard spec turns any third
 * state red rather than letting it read as "not ready yet". The helper is duplicated from that
 * file rather than shared, because Task 20 modifies no file Plan 3 owns.
 */
async function openApp(page: Page): Promise<void> {
  const response = await page.goto('/');
  const body = (await response?.text()) ?? '';
  test.skip(!/^\s*<!doctype html/i.test(body), SPA_PENDING);
}

async function signInBrowser(page: Page): Promise<void> {
  await openApp(page);
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
}

/**
 * Every string a reader actually sees — the browser twin of `visibleTexts` in
 * `packages/web/src/routes/Applications.test.tsx`. `innerText`, not `textContent`: it is what the
 * page RENDERS, it omits anything hidden, and it puts a newline between block elements. That last
 * property is what keeps the check honest — `sentences()` splits on newlines too, so two
 * neighbouring paragraphs can never be spliced into one pseudo-sentence that hides a violation in
 * the seam or invents one nobody can read on screen. (`page.evaluate` with `document` would be the
 * literal twin, but this repository's root tsconfig ships no DOM lib and `npm run typecheck`
 * covers `e2e/`.)
 */
async function visibleTexts(page: Page): Promise<string[]> {
  return [await page.locator('body').innerText()];
}

test.describe('the writing desk in a browser', () => {
  test('the writing desk is reachable from the primary navigation', async ({ page }) => {
    await signInBrowser(page);
    // Reached by CLICKING the rail, never by page.goto: a `goto('/templates')` passes against a
    // build in which nothing links to the writing desk at all, which is the state this plan
    // shipped in before the audit.
    const nav = page.getByRole('navigation', { name: 'Primary' });
    await expect(nav.getByRole('link', { name: 'Templates' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Applications' })).toBeVisible();

    await nav.getByRole('link', { name: 'Applications' }).click();
    await expect(page).toHaveURL(/\/applications$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Applications' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New draft' })).toBeVisible();

    // One `main` landmark on the page. The shell renders `<main id="main">` and the skip link
    // points at it; a second one nested inside a route makes "Skip to main content" ambiguous and
    // is invisible to any component test, which renders the route without the shell.
    await expect(page.getByRole('main')).toHaveCount(1);
  });

  test('an opportunity deep-links into a draft with the funder overlay pre-selected', async ({
    page,
  }) => {
    await signInBrowser(page);
    const programId = programIdByName(ARDC_PROGRAM_NAME);
    await page.goto(`/o/${programId}`);

    const start = page.getByRole('link', { name: 'Start an application for this program' });
    await expect(start).toBeVisible();
    await start.click();

    await expect(page).toHaveURL(new RegExp(`/applications\\?programId=${programId}`));
    await expect(page.getByText(/Drafting for/)).toBeVisible();
    // The overlay bound to this funder, pre-selected — the deep link carrying programId, klass and
    // funderId all the way through `selectTemplates` to a button the applicant can press.
    await expect(page.getByRole('button', { name: /Insert ARDC Grants Program/ })).toBeVisible();
  });

  test('the template library shows components, playbooks and their citations', async ({ page }) => {
    await signInBrowser(page);
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Templates' }).click();
    await expect(page).toHaveURL(/\/templates$/);

    const sections = page.getByRole('region', { name: 'Sections' });
    await expect(sections.getByRole('heading', { name: 'Sections' })).toBeVisible();
    await expect(sections.getByRole('button', { name: /^Need statement/ })).toBeVisible();

    const always = page.getByRole('region', { name: 'Always available' });
    await expect(always.getByRole('button', { name: /Campus student government playbook/ })).toBeVisible();
    await expect(always.getByRole('link', { name: /Florida State University SGA/i })).toHaveAttribute(
      'href',
      /sga\.fsu\.edu/,
    );

    await always.getByRole('button', { name: /Campus student government playbook/ }).click();
    // The template's own words, unaltered — the trap this playbook exists to name.
    await expect(page.getByText(/capital equipment is frequently barred/i)).toBeVisible();
  });

  test('a draft fills from a template, shows its gaps beside the checklist, and gates export', async ({
    page,
  }) => {
    await signInBrowser(page);
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Applications' }).click();
    await page.getByRole('button', { name: 'New draft' }).click();

    const sections = page.getByRole('region', { name: 'Insert a section' });
    await sections.getByRole('button', { name: /^Need statement/ }).click();

    // `toHaveValue`, not `toContainText`: a controlled textarea's text is its value property.
    const body = page.getByLabel('Draft', { exact: true });
    await expect(body).toHaveValue(/\[TODO: club\.callsign — /);
    await expect(body).not.toHaveValue(/\{\{/);

    // GAPS BESIDE THE CHECKLIST, NEVER IN IT. The hint inside an unfilled callsign marker carries
    // `e.g. W8UM`; it is an instruction to the writer and must never appear as a fact awaiting a
    // human signature.
    const gaps = page.getByRole('region', { name: 'Gaps to fill' });
    await expect(gaps.getByText('[TODO: club.callsign', { exact: false }).first()).toBeVisible();
    await expect(gaps.getByText(/W8UM/).first()).toBeVisible();

    const checklist = page.getByRole('region', { name: 'Fact checklist' });
    await expect(checklist.getByText('W8UM')).toHaveCount(0);
    await expect(checklist.getByText(/unresolved \[TODO: …\] markers? remains?/)).toBeVisible();

    // Now write the section, gaps and all, and work the checklist to the end.
    await body.fill('W8UM spent $1,450 on one Icom IC-7300 on March 7, 2027.');
    await body.blur();

    await expect(checklist.getByText(/assertions? still needs? confirmation/)).toBeVisible();
    // Tick them one at a time, and `click()` rather than `check()`. These checkboxes are
    // CONTROLLED by the server's own answer: `checked={item.confirmed}` with no optimistic flip,
    // so React restores the box to unchecked the moment the click's change event settles and it
    // only turns on when the PUT comes back and the checklist is re-rendered. Playwright's
    // `check()` asserts the state changed with the click and therefore fails against it —
    // "Clicking the checkbox did not change its state", measured here. That is the honest
    // behaviour to keep: a tick means the confirmation is STORED, not that a box was pressed. So
    // the wait is on the unchecked set shrinking, which is the server having answered.
    for (let i = 0; i < 20; i += 1) {
      const unchecked = checklist.getByRole('checkbox').and(page.locator(':not(:checked)'));
      const remaining = await unchecked.count();
      if (remaining === 0) break;
      await unchecked.first().click();
      await expect(unchecked).toHaveCount(remaining - 1);
    }
    await expect(checklist.getByText(/ready to export/i)).toBeVisible();
    await expect(page.getByRole('region', { name: 'Gaps to fill' }).getByText(/No gap markers/)).toBeVisible();
  });

  test('the prose check reports where a passage is generic, without a score', async ({ page }) => {
    await signInBrowser(page);
    // Deliberately a direct URL: /applications must also survive a bookmark or a reload.
    await page.goto('/applications');
    await page.getByRole('button', { name: 'New draft' }).click();

    const body = page.getByLabel('Draft', { exact: true });
    await body.fill(
      "In today's rapidly evolving landscape, our organization delves into the transformative potential of amateur radio. Furthermore, this comprehensive initiative underscores our unwavering commitment to educate, empower, and inspire learners, ensuring long-term impact for years to come.",
    );
    await body.blur();
    await page.getByRole('button', { name: 'Run prose check' }).click();

    const prose = page.getByRole('region', { name: 'Prose check' });
    await expect(prose.getByText(/Paragraph 1 has no proper noun and no figure/i)).toBeVisible();
    await expect(prose.getByText('Furthermore')).toBeVisible();
    await expect(prose.getByText("In today's rapidly evolving landscape")).toBeVisible();
    await expect(prose.getByText(/Style words per 100 words/i)).toBeVisible();
    // It reports; it does not rate, and it never says a machine wrote this.
    await expect(page.getByText(/AI-written|AI-generated/i)).toHaveCount(0);
  });

  test('the copy-prompt button carries the exact required copy, and promises nothing else', async ({
    page,
  }) => {
    await signInBrowser(page);
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Applications' }).click();
    await page.getByRole('button', { name: 'New draft' }).click();

    await expect(page.getByRole('button', { name: COPY_PROMPT_LABEL })).toBeVisible();
    await expect(page.getByText(/Includes: this funder/)).toBeVisible();
    await expect(page.getByText(/never-invent-a-citation/)).toBeVisible();

    // The label says "AI-detection avoidance", which a reader could take as a promise about a
    // classifier. Nothing on the rendered screen may make that promise.
    assertNoEvasionPromise(await visibleTexts(page), 'the writing desk');
  });
});
