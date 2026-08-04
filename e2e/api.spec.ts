/**
 * The product's journeys, exercised end-to-end against the REAL built server.
 *
 * Every request below goes over HTTP to `node packages/server/dist/index.js`, running the real
 * `createApp`, the real migrations, the real corpus (150 publishable records plus the 553 the
 * product stores and hides) and the real session cookie. Nothing is stubbed, nothing is faked and
 * no router is constructed by hand.
 *
 * WHY THESE JOURNEYS AND NOT "THE PAGES LOAD". Each one pins something this product had to fight
 * for and would silently lose:
 *   - a verdict census that is honest about what it does not know;
 *   - `unknown` as a real state that never reads as a soft "no";
 *   - a deadline shown on the funder's own calendar day;
 *   - a projected date that never claims to be published;
 *   - suppressed records that stay unreachable even to someone guessing an id;
 *   - a hijacked domain that appears as a warning and never as a link;
 *   - "members read, admins decide", enforced by the server rather than by the UI;
 *   - an obligation nobody stated reading as unstated rather than as "not required".
 *
 * The browser journeys for the same flow live in `flow.spec.ts` and wait on Plan 5's SPA
 * middleware; these do not, because `/api` is Plan 3's own surface and is complete today.
 */
import { expect, test, type APIRequestContext } from '@playwright/test';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  ARRL_CATALOG_SOURCE_ID,
  ARRL_SCHOLARSHIP_NAME,
  insertChangeEvent,
  MEMBER_EMAIL,
  MEMBER_PASSWORD,
  OFFLINE_SOURCE_ID,
  programCounts,
  programIdByName,
  suppressedProgramIds,
} from './helpers.js';

interface ErrorBody {
  error: { code: string; message: string; details?: { unknownFields?: string[] } };
  requestId: string;
}

interface Verdict {
  kind: 'eligible' | 'eligible_preferred' | 'ineligible' | 'unknown';
  missingProfileFields?: string[];
  reasons?: Array<{ spec: { axis: string }; rawText: string }>;
}

interface BrowseRow {
  program: {
    id: string;
    name: string;
    applyUrl?: string;
    obligations: { costShareRequired?: boolean };
    trust: { status: string; sourceUrl: string; lastVerifiedAt: string };
    tags: string[];
  };
  verdict: Verdict | null;
  nextClosesAt: string | null;
  nextTimezone: string | null;
  nextIsEstimated: boolean | null;
  watched: boolean;
}

interface BrowseBody {
  rows: BrowseRow[];
  summary: {
    total: number;
    eligible: number;
    preferred: number;
    ineligible: number;
    unknown: number;
    unknownByField: Array<{ field: string; count: number }>;
    ineligibleByAxis: Array<{ axis: string; count: number }>;
  };
  total: number;
  profileApplied: string | null;
}

interface CalendarEntry {
  cycle: { closesAt: string | null; opensAt?: string; timezone: string | null };
  programName: string;
  isEstimated: boolean;
  deadlineSource: { kind: string; fromProgramName?: string };
  prepStartAt: string | null;
  status: string;
  lastVerifiedAt: string;
}

/**
 * The corpus profiler's `ee-undergrad`: "licensed EE undergraduate — General class since 2022,
 * BSEE at an accredited 4-year in TX, full-time, 3.6 GPA, US citizen, ARRL member since 2022,
 * age 20, female, financial need". It is the profile every eligibility figure in this repo was
 * measured with, so the numbers asserted below are the numbers `npm run profile-corpus` prints.
 */
const EE_UNDERGRAD = {
  kind: 'student',
  callsign: 'K5EXAMPLE',
  licenseClass: 'GENERAL',
  licensedSince: '2022-06-01T00:00:00.000Z',
  state: 'TX',
  callDistrict: '5',
  fieldOfStudy: 'Electrical Engineering',
  degreeLevel: 'BACH',
  institution: 'A State University',
  accredited: true,
  partTime: false,
  gpa: 3.6,
  arrlMemberSince: '2022-06-01T00:00:00.000Z',
  citizenship: 'US_CITIZEN',
  birthDate: '2006-03-01T00:00:00.000Z',
  stage: 'UNDERGRAD',
  activityKinds: ['club_member', 'on_air'],
  financialNeed: true,
  gender: 'female',
} as const;

async function signIn(api: APIRequestContext, email: string, password: string): Promise<void> {
  const res = await api.post('/api/auth/login', { data: { email, password } });
  expect(res.status(), await res.text()).toBe(200);
}

async function browseAsEeUndergrad(api: APIRequestContext): Promise<BrowseBody> {
  await signIn(api, MEMBER_EMAIL, MEMBER_PASSWORD);
  const saved = await api.put('/api/profiles/student', { data: EE_UNDERGRAD });
  expect(saved.status(), await saved.text()).toBe(200);
  const res = await api.get('/api/programs?pageSize=200');
  expect(res.status()).toBe(200);
  return (await res.json()) as BrowseBody;
}

/**
 * The day a funder would print on its own page, for an instant stored in UTC.
 * `2027-03-01T04:59:00.000Z` in America/New_York is 28 February — the ARRL's stated close.
 */
function funderCalendarDay(instantISO: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(instantISO));
}

test('log in, set a profile, browse with an honest census, star, calendar, receive a change event', async ({
  request,
}) => {
  // --- before a profile exists, the census claims nothing -------------------
  await signIn(request, MEMBER_EMAIL, MEMBER_PASSWORD);
  const anonymous = (await (await request.get('/api/programs?pageSize=200')).json()) as BrowseBody;
  expect(anonymous.total).toBe(150);
  expect(anonymous.profileApplied).toBeNull();
  // All four counters read zero against a non-zero total, and `profileApplied` is the
  // discriminator. "0 eligible" as a fact about a corpus nobody has been matched against would be
  // a false exclude, and a false exclude hides an award with no signal at all.
  expect(anonymous.summary).toMatchObject({ total: 150, eligible: 0, ineligible: 0, unknown: 0 });

  // --- set the profile, and browse with verdicts ---------------------------
  const browse = await browseAsEeUndergrad(request);
  expect(browse.profileApplied).toBe('student');

  // THE CENSUS, as `npm run profile-corpus -- ee-undergrad` measures it: 68 of 150 are open to
  // this applicant (55 plain + 13 preferred), 74 are not, and 8 cannot be decided at all.
  expect(browse.summary.eligible + browse.summary.preferred).toBe(68);
  expect(browse.summary).toMatchObject({
    total: 150,
    eligible: 55,
    preferred: 13,
    ineligible: 74,
    unknown: 8,
  });
  expect(browse.rows).toHaveLength(150);

  // --- star the programme 112 others inherit their deadline from -----------
  const arrlId = programIdByName(ARRL_SCHOLARSHIP_NAME);
  const starred = await request.post('/api/watches', { data: { programId: arrlId } });
  expect(starred.status()).toBe(201);
  const watches = (await (await request.get('/api/watches')).json()) as {
    rows: Array<{ program: { id: string } }>;
  };
  expect(watches.rows.map((r) => r.program.id)).toContain(arrlId);

  // --- the calendar, on an absolute window so the assertion is not a clock --
  const december = (await (
    await request.get('/api/calendar?from=2026-12-01T00:00:00.000Z&to=2027-01-01T00:00:00.000Z')
  ).json()) as { entries: CalendarEntry[]; undated: unknown[] };
  expect(december.entries).toHaveLength(113);
  // Every one of them on a single day, and 112 of them one portal's date rather than 113
  // coincidences. This is why `deadlineSource` is on the entry at all.
  const days = new Set(december.entries.map((e) => (e.cycle.closesAt ?? '').slice(0, 10)));
  expect([...days]).toEqual(['2026-12-30']);
  const inherited = december.entries.filter((e) => e.deadlineSource.kind === 'inherited');
  expect(inherited).toHaveLength(112);
  expect(new Set(inherited.map((e) => e.deadlineSource.fromProgramName))).toEqual(
    new Set([ARRL_SCHOLARSHIP_NAME]),
  );
  // No bare dates: every entry carries its own provenance and a labelled status.
  for (const entry of december.entries) {
    expect(entry.lastVerifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entry.status).not.toBe('');
  }
  // Prep lead time is a real date, not a decoration.
  expect(december.entries.filter((e) => e.prepStartAt !== null).length).toBeGreaterThan(0);

  // --- a change event lands on the watched programme -----------------------
  // "ARRL moved the scholarship close from Jan 31 to Dec 30" — spec §11.2. The row is written
  // exactly as the nightly crawl writes it; the drain, the fan-out and the rendering are the
  // product's own and run inside the server on the next read.
  insertChangeEvent({
    id: 'e2e-api-deadline-change',
    sourceId: ARRL_CATALOG_SOURCE_ID,
    programId: arrlId,
    kind: 'deadline_changed',
    before: 'January 31',
    after: 'December 30, 12:00 PM EST',
    detectedAt: new Date().toISOString(),
    fieldPath: 'deadline.note',
  });

  const digest = (await (await request.get('/api/notifications')).json()) as {
    rows: Array<{
      title: string;
      body: string;
      before: string | null;
      after: string | null;
      programId: string | null;
      readAt: string | null;
    }>;
    unread: number;
  };
  const delivered = digest.rows.find((r) => r.title.startsWith('Deadline changed'));
  expect(delivered, JSON.stringify(digest.rows)).toBeDefined();
  expect(delivered?.title).toBe(`Deadline changed: ${ARRL_SCHOLARSHIP_NAME}`);
  expect(delivered?.before).toBe('January 31');
  expect(delivered?.after).toBe('December 30, 12:00 PM EST');
  expect(delivered?.programId).toBe(arrlId);
  // The blast radius is in the body, because one date moving is 113 applications moving.
  expect(delivered?.body).toContain('112 other programmes inherit this cycle');
  expect(digest.unread).toBeGreaterThan(0);

  // And it is clearable without being erased: read state changes, the record stays.
  expect((await request.post('/api/notifications/read-all', { data: {} })).status()).toBe(204);
  const cleared = (await (await request.get('/api/notifications')).json()) as {
    rows: unknown[];
    unread: number;
  };
  expect(cleared.unread).toBe(0);
  expect(cleared.rows.length).toBe(digest.rows.length);

  // Unstarring is real, so the journey leaves the account as it found it.
  expect((await request.delete(`/api/watches/${arrlId}`)).status()).toBe(204);
});

test('unknown is a real state, and an unset field never becomes a "no"', async ({ request }) => {
  const browse = await browseAsEeUndergrad(request);

  const unknown = browse.rows.filter((r) => r.verdict?.kind === 'unknown');
  expect(unknown).toHaveLength(8);

  // Every unknown names the profile fields it is waiting on, and every one of those fields is a
  // field this profile leaves unset. That is the matcher invariant the whole completeness report
  // rests on: an unset profile field yields `unknown`, never `ineligible`.
  const filled = new Set(Object.keys(EE_UNDERGRAD));
  for (const row of unknown) {
    expect(row.verdict?.missingProfileFields?.length ?? 0).toBeGreaterThan(0);
    for (const field of row.verdict?.missingProfileFields ?? []) {
      expect(filled.has(field), `${row.program.name} is waiting on "${field}", which IS set`).toBe(
        false,
      );
    }
  }
  expect(browse.summary.unknownByField.map((f) => f.field).sort()).toEqual([
    'county',
    'cwWpm',
    'lat',
    'lon',
  ]);

  // The census can therefore be read as a sentence: 8 of these are questions, not refusals.
  expect(browse.summary.unknown).toBe(8);
  expect(browse.summary.unknown + browse.summary.ineligible).toBeLessThan(browse.summary.total);

  // An ineligible verdict, by contrast, quotes the funder's own words for every reason it gives.
  const ineligible = browse.rows.filter((r) => r.verdict?.kind === 'ineligible');
  expect(ineligible).toHaveLength(74);
  for (const row of ineligible.slice(0, 20)) {
    expect(row.verdict?.reasons?.length ?? 0).toBeGreaterThan(0);
    for (const reason of row.verdict?.reasons ?? []) {
      expect(reason.rawText.trim().length).toBeGreaterThan(0);
      expect(reason.spec.axis.length).toBeGreaterThan(0);
    }
  }
});

test("a deadline is the funder's own calendar day, not its UTC instant", async ({ request }) => {
  const browse = await browseAsEeUndergrad(request);

  const zoned = browse.rows.filter(
    (r): r is BrowseRow & { nextClosesAt: string; nextTimezone: string } =>
      r.nextClosesAt !== null && r.nextTimezone !== null,
  );
  expect(zoned.length).toBeGreaterThan(100);

  // Deadlines are UTC instants of a 23:59 LOCAL wall time, so slicing the ISO string prints the
  // wrong day for every US funder whose close falls after 19:00 Eastern. Five of the 150 rows are
  // in that state right now; the projection carries `nextTimezone` (migration 037) precisely so
  // the web layer can render the day the funder published rather than the day UTC agrees with.
  const wrongWithoutTimezone = zoned.filter(
    (r) => r.nextClosesAt.slice(0, 10) !== funderCalendarDay(r.nextClosesAt, r.nextTimezone),
  );
  expect(wrongWithoutTimezone).toHaveLength(5);
  for (const row of wrongWithoutTimezone) {
    // Every one of them is a US zone at a minute that has already rolled over in UTC.
    expect(row.nextTimezone).toMatch(/^America\//);
    expect(row.nextClosesAt).toMatch(/T0[0-9]:\d\d/);
  }

  // The same instant, the same rule, on the detail route: the cycle carries its own zone.
  const arrlId = programIdByName(ARRL_SCHOLARSHIP_NAME);
  const detail = (await (await request.get(`/api/programs/${arrlId}`)).json()) as {
    cycles: Array<{ closesAt: string; timezone: string }>;
  };
  expect(detail.cycles.length).toBeGreaterThan(0);
  for (const cycle of detail.cycles) {
    expect(cycle.timezone).toBe('America/New_York');
    expect(funderCalendarDay(cycle.closesAt, cycle.timezone)).toMatch(/-12-30$/);
  }
});

test('a projected date is never presented as one the funder published', async ({ request }) => {
  await signIn(request, MEMBER_EMAIL, MEMBER_PASSWORD);

  // An 18-month absolute window, which is the corpus's own cycle horizon.
  const horizon = (await (
    await request.get('/api/calendar?from=2026-08-02T00:00:00.000Z&to=2028-02-02T00:00:00.000Z')
  ).json()) as { entries: CalendarEntry[]; undated: Array<{ deadlineKind: string }> };

  expect(horizon.entries).toHaveLength(243);
  const published = horizon.entries.filter((e) => !e.isEstimated);
  const projected = horizon.entries.filter((e) => e.isEstimated);
  // FOUR. Everything else on this wall was worked out from a recurrence rule and the funder has
  // announced none of it.
  expect(published).toHaveLength(4);
  expect(projected).toHaveLength(239);
  expect(published.map((e) => e.programName).sort()).toEqual([
    'ARISS-USA ISS Contact Proposal',
    'Geospace Facilities',
    'Public Wireless Supply Chain Innovation Fund Grant Program – Solutions for AI-Native RAN',
    'Yaesu System Fusion DR-2X Repeater Program',
  ]);

  // A narrow window is where the two channels used to collapse into one: a September view built
  // from `expandCycles` alone returned 1 entry instead of 3, dropping both funder-published
  // windows — the authoritative ones — and keeping only the guess.
  const september = (await (
    await request.get('/api/calendar?from=2026-08-02T00:00:00.000Z&to=2026-09-30T00:00:00.000Z')
  ).json()) as { entries: CalendarEntry[]; undated: unknown[] };
  expect(september.entries).toHaveLength(3);
  expect(september.entries.filter((e) => !e.isEstimated)).toHaveLength(2);

  // `undated` is horizon-wide, not window-scoped. When it was window-scoped a September view
  // called 147 of 150 programmes deadline-less, which is a statement about the window dressed up
  // as a statement about the corpus.
  expect(horizon.undated).toHaveLength(28);
  expect(september.undated).toHaveLength(28);
});

test('suppressed records never surface, to anyone, by any route', async ({ request }) => {
  await signIn(request, MEMBER_EMAIL, MEMBER_PASSWORD);

  // The database really is holding them: 150 publishable of 703 stored.
  const counts = programCounts();
  expect(counts.suppressed).toBe(553);
  expect(counts.total).toBe(703);

  const browse = (await (await request.get('/api/programs?pageSize=200')).json()) as BrowseBody;
  expect(browse.total).toBe(150);

  const hidden = suppressedProgramIds(5);
  expect(hidden).toHaveLength(5);
  for (const id of hidden) {
    expect(browse.rows.some((r) => r.program.id === id)).toBe(false);
    // 404, not 403: a suppressed record is not a resource this user may not see, it is not
    // published at all, and 403 would confirm the id exists. This route once answered 200 with
    // the full record — including an "apply here" that was a grant recipient's Facebook page.
    const detail = await request.get(`/api/programs/${id}`);
    expect(detail.status(), id).toBe(404);
    expect(((await detail.json()) as ErrorBody).error.code).toBe('not_found');
  }

  // Admin is not an exception. Suppression is about what the record IS, not about who is asking.
  await signIn(request, ADMIN_EMAIL, ADMIN_PASSWORD);
  expect((await request.get(`/api/programs/${hidden[0]}`)).status()).toBe(404);
});

test('the farweb.org record is a safety warning, and never a link', async ({ request }) => {
  await signIn(request, MEMBER_EMAIL, MEMBER_PASSWORD);

  // A user searching "FAR" must reach the warning, not a link to a domain that now redirects to
  // an Indonesian gambling site — ARRL, QCWA and club pages still tell applicants to apply there.
  const search = (await (await request.get('/api/programs?q=FAR&pageSize=50')).json()) as BrowseBody;
  const far = search.rows.find((r) => r.program.tags.includes('key:far-farweb-org-compromised'));
  expect(far, 'searching FAR must return the interception record').toBeDefined();
  expect(far?.program.name).toContain('domain compromised, do not apply');

  const detail = (await (await request.get(`/api/programs/${far?.program.id}`)).json()) as {
    program: { applyUrl?: string; summary: string; rawOtherText: string; tags: string[] };
  };
  // The record names the danger in words...
  expect(detail.program.tags).toContain('safety_warning');
  expect(detail.program.summary).toContain('SAFETY WARNING');
  expect(detail.program.rawOtherText).toMatch(/redirects to an Indonesian online-gambling site/);
  // ...and points applicants somewhere that still exists...
  expect(detail.program.applyUrl).toBe('https://www.arrl.org/scholarship-program');
  // ...and carries no URL on the dead domain anywhere in the payload the browser will render.
  expect(JSON.stringify(detail)).not.toMatch(/https?:\/\/[^"]*farweb\.org/);
});

test('an obligation the funder never mentioned is unstated, not "not required"', async ({
  request,
}) => {
  const browse = await browseAsEeUndergrad(request);

  const costShare = browse.rows.map((r) => r.program.obligations.costShareRequired);
  // 148 unstated, 2 stated true, and ZERO stated false — no funder in this corpus has ever said
  // "cost share is not required" in words. Rendering absence as "Not required" invents a promise
  // the funder never made, on 148 records.
  expect(costShare.filter((v) => v === undefined)).toHaveLength(148);
  expect(costShare.filter((v) => v === true)).toHaveLength(2);
  expect(costShare.filter((v) => v === false)).toHaveLength(0);
});

test('members read the inbox, and only admins decide — enforced by the server', async ({
  request,
}) => {
  await signIn(request, MEMBER_EMAIL, MEMBER_PASSWORD);

  // Readable, and the response says so itself rather than leaving the UI to guess.
  const inbox = await request.get('/api/inbox');
  expect(inbox.status()).toBe(200);
  expect(((await inbox.json()) as { canDecide: boolean }).canDecide).toBe(false);

  // 403 BEFORE the item is looked up: a member gets the same answer for a real id and an invented
  // one, so the queue's contents cannot be probed by watching which refusal comes back.
  const decision = await request.post('/api/inbox/no-such-item/decision', {
    data: { decision: 'approved' },
  });
  expect(decision.status()).toBe(403);
  expect(((await decision.json()) as ErrorBody).error.code).toBe('forbidden');

  // The sources page is readable by a member and configurable by nobody else.
  const health = await request.get('/api/sources/health');
  expect(health.status()).toBe(200);
  expect(((await health.json()) as { canConfigure: boolean }).canConfigure).toBe(false);
  expect((await request.patch(`/api/sources/${OFFLINE_SOURCE_ID}`, { data: { enabled: false } })).status()).toBe(403);
  expect((await request.post('/api/sources/crawl', { data: { sourceIds: [] } })).status()).toBe(403);

  // And user management is not reachable at all.
  expect((await request.get('/api/admin/users')).status()).toBe(403);
  expect((await request.post('/api/admin/users', { data: { email: 'x@example.com' } })).status()).toBe(403);
});

test('an admin manages accounts, configures a source, and runs a crawl that touches no network', async ({
  request,
}) => {
  await signIn(request, ADMIN_EMAIL, ADMIN_PASSWORD);

  // --- user management (spec §12) -----------------------------------------
  const created = await request.post('/api/admin/users', {
    data: { email: 'api-second-member@example.com', role: 'member' },
  });
  expect(created.status(), await created.text()).toBe(201);
  const createdBody = (await created.json()) as { generatedPassword: string };
  // Generated, shown once, never stored in the clear.
  expect(createdBody.generatedPassword.length).toBeGreaterThan(8);
  const users = (await (await request.get('/api/admin/users')).json()) as {
    rows: Array<{ email: string }>;
  };
  expect(users.rows.map((u) => u.email)).toContain('api-second-member@example.com');

  // --- source configuration ------------------------------------------------
  const patched = await request.patch(`/api/sources/${ARRL_CATALOG_SOURCE_ID}`, {
    data: { expectedMinRecords: 105 },
  });
  expect(patched.status()).toBe(200);
  expect(
    ((await patched.json()) as { source: { expectedMinRecords: number } }).source.expectedMinRecords,
  ).toBe(105);

  // Identity is the source module's, not an admin's. A request that tries to point a source
  // somewhere new is refused out loud rather than silently ignored — the fetcher blocklist
  // (farweb.org among them) is not configurable from the product at all.
  const refused = await request.patch(`/api/sources/${ARRL_CATALOG_SOURCE_ID}`, {
    data: { url: 'https://example.com/somewhere-else' },
  });
  expect(refused.status()).toBe(422);
  expect(((await refused.json()) as ErrorBody).error.details?.unknownFields).toEqual(['url']);

  // --- the manual crawl ----------------------------------------------------
  // CRAWL_ENABLED is false for the e2e server, so the scheduler never fires; this is the only
  // thing that runs a crawl in this process, and it runs the identical CrawlDeps the 03:17 run
  // would (RESOLUTIONS R23). `manual-tier-d` is the one source with `requests: []`, so this
  // exercises the whole path — parse, diff, review queue, source health — while reaching out to
  // nobody. A suite that crawled the real sources would hammer ~25 small nonprofits' sites.
  const crawl = await request.post('/api/sources/crawl', {
    data: { sourceIds: [OFFLINE_SOURCE_ID] },
  });
  expect(crawl.status(), await crawl.text()).toBe(200);
  const crawlBody = (await crawl.json()) as {
    results: Array<{ sourceId: string; parsedCount: number; error?: string }>;
  };
  expect(crawlBody.results).toHaveLength(1);
  expect(crawlBody.results[0]?.sourceId).toBe(OFFLINE_SOURCE_ID);
  expect(crawlBody.results[0]?.error).toBeUndefined();
  expect(crawlBody.results[0]?.parsedCount).toBe(16);

  // The crawl wrote its own health back, so the page an operator reads is the run that happened.
  const health = (await (await request.get('/api/sources/health')).json()) as {
    rows: Array<{ id: string; lastRecordCount: number | null; health: { state: string } }>;
  };
  const crawled = health.rows.find((s) => s.id === OFFLINE_SOURCE_ID);
  expect(crawled?.lastRecordCount).toBe(16);
  expect(crawled?.health.state).toBe('healthy');
});

test('the completeness meter speaks for the corpus the user can actually reach', async ({
  request,
}) => {
  await signIn(request, MEMBER_EMAIL, MEMBER_PASSWORD);
  const saved = await request.put('/api/profiles/student', { data: EE_UNDERGRAD });
  expect(saved.status()).toBe(200);

  const body = (await saved.json()) as {
    completenessFor: string | null;
    completeness: { total: number; unknownCount: number; score: number };
  };
  // FOUND BY THIS SUITE (2026-08-04). Against a database holding the corpus's 553 suppressed
  // records as well as its 150 publishable ones, this read 703 and a score of 92 — the meter was
  // the one read surface that did not call `isDoNotPublish`, and past awards match trivially, so
  // every one of them inflated it. 150 is the number of programmes the user can open.
  expect(body.completeness.total).toBe(150);
  expect(body.completeness.unknownCount).toBe(8);
  expect(body.completenessFor).toBe('student');

  const me = (await (await request.get('/api/me')).json()) as {
    completeness: { total: number };
  };
  expect(me.completeness.total).toBe(150);
});
