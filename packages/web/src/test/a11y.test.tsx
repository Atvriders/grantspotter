import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { auditA11y } from './a11y.js';
import { SessionContext, makeSessionValue } from '../store/session.js';
import { AppShell } from '../components/AppShell.js';
import { Browse } from '../routes/Browse.js';
import { Calendar } from '../routes/Calendar.js';
import { Watchlist } from '../routes/Watchlist.js';
import { Profile } from '../routes/Profile.js';
import { Inbox } from '../routes/Inbox.js';
import { Sources } from '../routes/Sources.js';
import { Admin } from '../routes/Admin.js';
import { Enroll } from '../routes/Enroll.js';
import { FirstRun } from '../routes/FirstRun.js';
import { Login } from '../routes/Login.js';
import { Opportunity } from '../routes/Opportunity.js';
import {
  ARRL_GRANTS_ROW,
  CHICAGO_FM_ROW,
  FAR_SAFETY_ROW,
  makeResponse,
} from './programRowFixtures.js';

const NOW = '2026-08-02T12:00:00.000Z';

/**
 * THE WHOLE SPA, AUDITED TOGETHER, ON DATA THAT LOOKS LIKE THE CORPUS.
 *
 * Every other Plan 3 route shipped with its own suite and its own stub. This file is the first
 * thing that renders all nine of them against one set of fixtures, which is the only way the
 * cross-route rules — one `<h1>`, no positive tabindex, every control named, no dangling IDREF —
 * can be checked at all.
 *
 * The fixtures are deliberately NOT empty. An audit of a page showing "no results" proves nothing
 * about the page a user sees: the safety-warning record, the projected deadline, the unstated
 * obligation and the unknown verdict are exactly the four things this product's honesty rests on,
 * and they only exist on screen when there is data.
 */

const BROWSE = makeResponse({
  rows: [ARRL_GRANTS_ROW, CHICAGO_FM_ROW, FAR_SAFETY_ROW],
  summary: {
    total: 3,
    eligible: 0,
    preferred: 0,
    ineligible: 1,
    unknown: 1,
    ineligibleByAxis: [{ axis: 'other', count: 1 }],
    unknownByField: [{ field: 'is501c3', count: 1 }],
  },
  total: 3,
});

/** `obligations: {}` — unstated on 148 of 150 records, and `false` on ZERO of them. */
const DETAIL = {
  program: {
    id: 'arrl-amateur-radio-grants',
    funderId: 'arrl',
    name: 'ARRL Amateur Radio Grants',
    klass: 'ham_grant',
    summary: 'Grants for clubs and schools.',
    applicantEntities: ['club_501c3'],
    amount: {
      instrument: 'cash_range',
      amountRaw: 'Up to $25,000',
      awardCountRaw: 'Not published',
    },
    deadline: {
      kind: 'annual_window',
      source: { kind: 'self' },
      note: 'Applications are accepted in February.',
    },
    applyVia: 'page_form',
    applyUrl: 'https://www.arrl.org/arrl-grants',
    constraints: [],
    fundingRestrictions: [],
    obligations: {},
    aiPolicy: { stance: 'unaddressed' },
    trust: {
      status: 'unknown',
      sourceUrl: 'https://www.arrl.org/arrl-grants',
      lastVerifiedAt: '2026-08-01T00:00:00.000Z',
      verificationMethod: 'live_fetch',
      contentHash: 'abc123def456789a',
    },
    rawOtherText: '',
    tags: ['tier:A'],
  },
  funder: { id: 'arrl', name: 'ARRL', homepage: 'https://www.arrl.org/' },
  cycles: [
    {
      id: 'c1',
      programId: 'arrl-amateur-radio-grants',
      opensAt: '2027-02-01T05:00:00.000Z',
      // 23:59 America/New_York on 28 February 2027. Rendered in UTC this is one day late.
      closesAt: '2027-03-01T04:59:00.000Z',
      timezone: 'America/New_York',
      label: 'February 2027',
      isEstimated: true,
    },
  ],
  provenance: [],
  verdict: { kind: 'unknown', missingProfileFields: ['is501c3'] },
  watched: false,
  deadlineOwner: null,
};

const CALENDAR = {
  from: NOW,
  to: '2027-08-02T12:00:00.000Z',
  entries: [
    {
      cycle: {
        id: 'c1',
        programId: 'arrl-foundation-scholarship',
        opensAt: '2026-10-30T00:00:00.000Z',
        closesAt: '2026-12-30T17:00:00.000Z',
        timezone: 'America/New_York',
        label: 'Dec 2026 close',
        isEstimated: false,
      },
      programId: 'arrl-foundation-scholarship',
      programName: 'ARRL Foundation Scholarship Program',
      funderName: 'ARRL Foundation',
      klass: 'ham_scholarship',
      instrument: 'cash_range',
      applicantEntities: ['individual'],
      isEstimated: false,
      deadlineSource: { kind: 'stated' },
      prepLeadDays: 30,
      prepStartAt: '2026-11-30T17:00:00.000Z',
      prepNote: 'The ARRL application needs a transcript and references.',
      decisionLagMinDays: null,
      decisionLagMaxDays: null,
      watched: false,
      verdictKind: 'eligible',
      status: 'unknown',
      lastVerifiedAt: '2026-07-20T00:00:00.000Z',
    },
    {
      cycle: {
        id: 'c2',
        programId: 'ardc-grants',
        closesAt: '2026-08-20T00:00:00.000Z',
        timezone: 'UTC',
        label: 'Aug 2026 cycle',
        isEstimated: true,
      },
      programId: 'ardc-grants',
      programName: 'ARDC Grants Program',
      funderName: 'Amateur Radio Digital Communications',
      klass: 'ham_grant',
      instrument: 'cash_range',
      applicantEntities: ['university'],
      isEstimated: true,
      deadlineSource: {
        kind: 'inherited',
        fromProgramId: 'arrl-foundation-scholarship',
        fromProgramName: 'ARRL Foundation Scholarship Program',
      },
      prepLeadDays: 45,
      prepStartAt: '2026-08-05T00:00:00.000Z',
      prepNote: 'ARDC evaluates for 60 to 120 days after a cycle closes.',
      decisionLagMinDays: 60,
      decisionLagMaxDays: 120,
      watched: true,
      verdictKind: 'unknown',
      status: 'unknown',
      lastVerifiedAt: '2026-07-28T00:00:00.000Z',
    },
  ],
  undated: [
    {
      programId: 'arrl-club-grant',
      programName: 'ARRL Club Grant Program',
      funderName: 'ARRL',
      deadlineKind: 'unpublished',
      deadlineNote: 'The deadline is not published on the page.',
      status: 'unknown',
      lastVerifiedAt: '2026-07-11T00:00:00.000Z',
    },
  ],
};

const WATCHES = {
  rows: [
    {
      program: {
        id: 'arrl-foundation-scholarship',
        name: 'ARRL Foundation Scholarship Program',
        tags: ['tier:C'],
        amount: { instrument: 'cash_range', amountRaw: '$500 - $25,000' },
        trust: {
          status: 'open',
          lastVerifiedAt: '2026-08-01T00:00:00.000Z',
          sourceUrl: 'https://www.arrl.org/scholarship-program',
          verificationMethod: 'live_fetch',
          contentHash: 'h1',
        },
      },
      funderName: 'ARRL Foundation',
      nextOpensAt: '2027-02-01T05:00:00.000Z',
      nextClosesAt: '2027-03-01T04:59:00.000Z',
      nextIsEstimated: true,
      nextTimezone: 'America/New_York',
    },
    {
      program: {
        id: 'far-farweb-org-compromised',
        name: 'Foundation for Amateur Radio (FAR) — domain compromised, do not apply',
        tags: ['tier:D', 'safety_warning'],
        amount: { instrument: 'unknown', amountRaw: null },
        trust: {
          status: 'discontinued',
          lastVerifiedAt: '2026-08-01T00:00:00.000Z',
          sourceUrl: 'https://www.arrl.org/scholarship-program',
          verificationMethod: 'manual_curation',
          contentHash: 'h3',
        },
      },
      funderName: 'Foundation for Amateur Radio',
      nextOpensAt: null,
      nextClosesAt: null,
      nextIsEstimated: false,
      nextTimezone: null,
    },
  ],
};

const NOTIFICATIONS = {
  unread: 1,
  rows: [
    {
      id: 'n1',
      sourceId: 'arrl-scholarship-descriptions',
      programId: 'arrl-foundation-scholarship',
      programName: 'ARRL Foundation Scholarship Program',
      kind: 'deadline_changed',
      title: 'The ARRL Foundation Scholarship Program deadline moved',
      body: 'Check the funder’s own page before you rely on either date.',
      fieldPath: 'deadline.note',
      before: 'January 31',
      after: 'December 30',
      createdAt: '2026-08-02T03:17:00.000Z',
      readAt: null,
    },
  ],
};

const INBOX = {
  canDecide: true,
  rows: [
    {
      id: 'ri-1',
      decision: 'pending',
      decidedBy: null,
      decidedAt: null,
      confidence: 0.82,
      rejectKey: null,
      candidate: {
        id: 'far-farweb-org-compromised',
        funderId: 'far',
        name: 'Foundation for Amateur Radio (FAR) — domain compromised, do not apply',
        klass: 'ham_scholarship',
        summary: 'The domain no longer belongs to FAR and now redirects elsewhere.',
        applicantEntities: ['individual'],
        amount: { instrument: 'unknown', amountRaw: '', awardCountRaw: '' },
        deadline: { kind: 'unpublished', source: { kind: 'self' }, note: 'Not published.' },
        applyVia: 'none',
        // The hijacked host, carried by the candidate exactly as a crawl would carry it.
        applyUrl: 'https://www.farweb.org/scholarships',
        constraints: [],
        fundingRestrictions: [],
        obligations: {},
        aiPolicy: { stance: 'unaddressed' },
        trust: {
          status: 'discontinued',
          sourceUrl: 'https://www.arrl.org/scholarship-program',
          lastVerifiedAt: '2026-08-01T00:00:00.000Z',
          verificationMethod: 'manual_curation',
          contentHash: 'far',
        },
        rawOtherText: '',
        tags: ['tier:D', 'safety_warning'],
      },
      changeEvent: {
        id: 'ce-1',
        sourceId: 'manual-tier-d',
        programId: 'far-farweb-org-compromised',
        kind: 'deadline_changed',
        before: 'January 31',
        after: 'December 30',
        detectedAt: '2026-08-02T03:17:00.000Z',
        fieldPath: 'deadline.note',
      },
    },
  ],
};

const PROFILES = {
  student: { kind: 'student', callsign: 'W1AW', licenseClass: 'GENERAL' },
  organization: null,
  completenessFor: 'student',
  completeness: {
    total: 150,
    unknownCount: 12,
    score: 74,
    fields: [{ field: 'gpa', resolves: 7 }],
  },
};

const SOURCES = {
  rows: [
    {
      id: 'arrl-scholarship-descriptions',
      label: 'ARRL scholarship catalog',
      tier: 'C',
      funderId: 'arrl-foundation',
      enabled: true,
      lastPolledAt: '2026-08-02T03:17:00.000Z',
      lastSuccessAt: '2026-08-02T03:17:00.000Z',
      consecutiveFailures: 0,
      lastRecordCount: 111,
      baselineRecordCount: null,
      expectedMinRecords: 100,
      health: { state: 'healthy', detail: '111 records on the last successful parse.' },
    },
    {
      id: 'austin-arc-grants',
      label: 'Austin ARC grants portal',
      tier: 'C',
      funderId: 'austin-arc',
      enabled: true,
      lastPolledAt: '2026-08-02T03:17:00.000Z',
      lastSuccessAt: '2026-08-02T03:17:00.000Z',
      consecutiveFailures: 0,
      lastRecordCount: 0,
      baselineRecordCount: null,
      expectedMinRecords: 0,
      health: {
        state: 'idle',
        detail: 'No records, which is expected for this source outside its open window.',
      },
    },
  ],
  summary: { total: 2, healthy: 2, unhealthy: 0 },
  canConfigure: true,
};

const ADMIN_USERS = {
  rows: [
    {
      id: 'u-admin',
      email: 'admin@example.com',
      displayName: 'The admin',
      role: 'admin',
      disabled: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastLoginAt: '2026-08-02T00:00:00.000Z',
      isSelf: true,
    },
    {
      id: 'u-member',
      email: 'member@example.com',
      displayName: '',
      role: 'member',
      disabled: false,
      createdAt: '2026-02-01T00:00:00.000Z',
      lastLoginAt: null,
      isSelf: false,
    },
  ],
};

const CHANNELS = {
  inApp: true,
  webhookUrl: null,
  ntfyServer: null,
  ntfyTopic: null,
  health: [
    {
      channel: 'webhook',
      lastAttemptAt: '2026-08-02T03:20:00.000Z',
      lastOkAt: '2026-07-01T03:20:00.000Z',
      lastStatus: 500,
      lastError: 'Internal Server Error',
      consecutiveFailures: 6,
    },
  ],
};

const FANOUT = {
  pendingEvents: 0,
  fannedOutEvents: 553,
  zeroRecipientEvents: 549,
  suppressed: [{ reason: 'unread_duplicate', events: 4, watchers: 2 }],
  lastFanoutAt: '2026-08-02T03:20:00.000Z',
  notifications: { total: 12, unread: 1 },
};

/**
 * A lookup that answers with a record for a DIFFERENT callsign than the one asked about, which is
 * what callook does with a superseded call: it returns the licensee's CURRENT record. Only the
 * test below presses the button, so this is inert for every other route.
 */
const CALLSIGN_LOOKUP = {
  status: 'found',
  record: {
    callsign: 'W5NEW',
    type: 'PERSON',
    name: 'ALEX Q EXAMPLE',
    operClass: 'GENERAL',
    operClassRaw: 'GENERAL',
    city: 'ANN ARBOR',
    state: 'MI',
    isPoBox: false,
    source: 'callook.info',
    fetchedAt: '2026-08-04T12:00:00.000Z',
  },
};

/** One router, so every route sees the body its own component actually asks for. */
function stubApi(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((url: string) => {
      const body = ((): unknown => {
        if (url === '/api/callsign/lookup') return CALLSIGN_LOOKUP;
        if (url.startsWith('/api/programs/')) return DETAIL;
        if (url.startsWith('/api/programs')) return BROWSE;
        if (url.startsWith('/api/calendar')) return CALENDAR;
        if (url.startsWith('/api/watches')) return WATCHES;
        if (url.startsWith('/api/notifications/health')) return FANOUT;
        if (url.startsWith('/api/notifications')) return NOTIFICATIONS;
        if (url.startsWith('/api/channels')) return CHANNELS;
        if (url.startsWith('/api/inbox')) return INBOX;
        if (url.startsWith('/api/profiles')) return PROFILES;
        if (url.startsWith('/api/sources')) return SOURCES;
        if (url.startsWith('/api/admin/users')) return ADMIN_USERS;
        return {};
      })();
      return Promise.resolve({ ok: true, status: 200, json: async () => body });
    }),
  );
}

const SESSION = makeSessionValue({
  user: { id: 'u-admin', email: 'admin@example.com', role: 'admin' },
  hasStudentProfile: true,
  completenessFor: 'student',
  completeness: PROFILES.completeness,
  unread: 1,
});

function mount(element: JSX.Element, path = '/'): ReturnType<typeof render> {
  return render(
    <SessionContext.Provider value={SESSION}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/o/:programId" element={element} />
          <Route path="*" element={element} />
        </Routes>
      </MemoryRouter>
    </SessionContext.Provider>,
  );
}

beforeEach(() => {
  stubApi();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Each route with a query that only resolves once its DATA is on screen. Waiting on the `<h1>`
 * alone would audit the loading state of six of these routes, which is not the page anybody uses.
 */
const ROUTES: Array<[string, JSX.Element, string, () => Promise<HTMLElement>]> = [
  ['Browse', <Browse now={NOW} />, '/', () => screen.findByRole('table', { name: /opportunities/i })],
  ['Calendar', <Calendar now={NOW} />, '/calendar', () => screen.findByRole('list', { name: /agenda/i })],
  [
    'Watchlist',
    <Watchlist now={NOW} />,
    '/watchlist',
    () => screen.findByRole('table', { name: /watched programs/i }),
  ],
  ['Profile', <Profile />, '/profile', () => screen.findByRole('heading', { name: /completeness/i })],
  ['Inbox', <Inbox />, '/inbox', () => screen.findByRole('button', { name: /^approve$/i })],
  [
    'Sources',
    <Sources />,
    '/sources',
    () => screen.findByRole('table', { name: /source health/i }),
  ],
  ['Admin', <Admin />, '/admin', () => screen.findByRole('table', { name: /user accounts/i })],
  [
    'Opportunity',
    <Opportunity now={NOW} />,
    '/o/arrl-amateur-radio-grants',
    () => screen.findByRole('heading', { level: 1, name: /ARRL Amateur Radio Grants/ }),
  ],
  [
    'Login',
    <Login onAuthenticated={() => undefined} />,
    '/login',
    () => screen.findByRole('button', { name: /sign in/i }),
  ],
  [
    'Enroll',
    <Enroll onAuthenticated={() => undefined} onCancel={() => undefined} />,
    '/enrol',
    () => screen.findByRole('button', { name: /create my account/i }),
  ],
  /**
   * THE SCREEN A SELF-HOSTER SEES FIRST, AND THE ONE THIS FILE HAD NEVER RENDERED.
   *
   * `Login` and `Enroll` were both here from the start; `FirstRun` — the third form on the same
   * panel, the only one that runs before an account exists, and the one the owner photographed —
   * appeared zero times. It is still the largest of the three: five fields and two explanations,
   * more markup than the other two together and every bit of it unaudited until this entry.
   *
   * It was six fields, four explanations and an embedded callsign lookup until 2026-08-11, when
   * account creation stopped asking for a callsign; the lookup and its panel now live on `Profile`
   * and are audited there.
   *
   * Mounted at `/`, because that is the path a fresh install answers with it.
   */
  [
    'FirstRun',
    <FirstRun onAuthenticated={() => undefined} onBootstrapClosed={() => undefined} />,
    '/',
    () => screen.findByRole('button', { name: /^create administrator$/i }),
  ],
];

describe('accessibility audit', () => {
  it.each(ROUTES)('%s has no accessibility violations', async (_name, element, path, ready) => {
    const { container } = mount(element, path);
    await ready();
    expect(auditA11y(container)).toEqual([]);
  });

  it('audits the month grid too, which the agenda view hides', async () => {
    const { container } = mount(<Calendar now={NOW} />, '/calendar');
    await screen.findByRole('list', { name: /agenda/i });
    await userEvent.click(screen.getByRole('tab', { name: /month/i }));
    await screen.findByRole('table', { name: /August 2026/ });
    expect(auditA11y(container)).toEqual([]);
  });

  it('audits the Inbox edit and reject panels, which are closed on arrival', async () => {
    const { container } = mount(<Inbox />, '/inbox');
    await userEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    expect(auditA11y(container)).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: /^reject$/i }));
    expect(auditA11y(container)).toEqual([]);
  });

  /**
   * THE CALLSIGN PANEL, WHICH NO OTHER AUDIT OPENS.
   *
   * `CallsignLookup` is closed on arrival everywhere it appears, so every audit above renders the
   * BUTTON and none of them renders the panel — a `<section>` with its own heading, a live region
   * and a fill-or-discard form.
   *
   * The record it opens on is W5NEW for a typed K9OLD, the superseded-callsign case, which is the
   * branch that renders the extra "not the one you asked about" apparatus.
   *
   * MOVED FROM `FirstRun` TO `Profile` ON 2026-08-11, WITH THE PANEL ITSELF. This test used to
   * mount the first-run screen and type into its callsign field, and it opened with a paragraph
   * arguing that first run was where the panel was least supported: no `AppShell` around it and no
   * account behind it. The field and the panel are gone from that screen — account creation stopped
   * asking for a callsign, and the lookup moved to the profile editor, where the person filling it
   * in is signed in and can see what it did. So the sentence about first run is deleted rather than
   * re-aimed: it named a screen that no longer carries this component.
   *
   * WHAT IS LOST AND WHAT IS NOT. The "no shell around it" half of the old argument survives by
   * accident and is worth stating: `mount` renders a bare route with no `AppShell`, so this is
   * still the panel audited outside the chrome. What genuinely goes is "before an account exists" —
   * the panel is now unreachable while signed out, which is a property `e2e/signedOut.spec.ts` and
   * `packages/server/src/api/callsign.ts` hold rather than something an audit could assert.
   */
  it('audits the callsign panel on the profile screen, which no other audit opens', async () => {
    const { container } = mount(<Profile />, '/profile');
    // The profile has to have LOADED before its callsign field exists; the routes table above
    // waits on the completeness heading for the same reason.
    await screen.findByRole('heading', { name: /completeness/i });
    await userEvent.clear(screen.getByLabelText(/^callsign$/i));
    await userEvent.type(screen.getByLabelText(/^callsign$/i), 'K9OLD');
    await userEvent.click(screen.getByRole('button', { name: /look up this callsign/i }));
    await screen.findByRole('heading', { name: /FCC record for/i });
    expect(auditA11y(container)).toEqual([]);
  });

  /**
   * The refusal, and the state after it. Same shape as the Enroll test below — a form that has
   * been told no is a different page from a form that has not been asked yet, and the alert that
   * carries the refusal is the part a screen reader has to be told about.
   */
  it('audits the first-run form after the setup token is refused', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({
          error: { code: 'unauthorized', message: 'Bad setup token.' },
          requestId: 'req-a11y-2',
        }),
      }),
    );
    const { container } = mount(
      <FirstRun onAuthenticated={() => undefined} onBootstrapClosed={() => undefined} />,
      '/',
    );
    await userEvent.type(screen.getByLabelText(/setup token/i), 'not-the-token');
    await userEvent.type(screen.getByLabelText(/^email$/i), 'operator@example.edu');
    await userEvent.type(screen.getByLabelText(/^password$/i), 'a-long-enough-password');
    await userEvent.type(screen.getByLabelText(/confirm password/i), 'a-long-enough-password');
    await userEvent.click(screen.getByRole('button', { name: /^create administrator$/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/setup token was not accepted/i);
    expect(auditA11y(container)).toEqual([]);
  });

  /**
   * A TEST STOOD HERE AND IS DELETED RATHER THAN REWRITTEN, AND THIS ONE IS NOT A LOSS.
   *
   * It was called "audits the stranded first-run screen, which replaces the form with an alert",
   * and it drove the `Administrator created` mode: the account exists and this browser is signed
   * in, but the starter profile write that followed it failed, so the screen replaced its own form
   * with a `role="alert"` and one button onwards. It was the only audit of a signed-out screen with
   * no form on it at all.
   *
   * THE MODE IS GONE FROM THE PRODUCT (2026-08-11), not merely unreachable from here. `FirstRun`
   * stopped asking for a callsign, which means it stopped writing a starter profile, which means
   * nothing runs between the account existing and the handover to the shell — there is no second
   * call left to fail and therefore no state in which an administrator can be created and then
   * stranded. `routes/FirstRun.tsx` says so at the line where `saveStarterProfile` used to be
   * called. There is no way to point this test at anything: the alert, the heading it waited on and
   * the button it audited are all deleted markup.
   *
   * The same deletion removes the one entry in `e2e/signedOut.spec.ts`'s WHAT IS NOT COVERED list
   * that named this mode; that note is corrected in the same round rather than left describing a
   * screen nobody can reach.
   *
   * WHAT IS STILL WORTH ASSERTING AND IS ASSERTED ELSEWHERE: the audit of a signed-out screen
   * showing a refusal instead of a resting form survives directly above, in "audits the first-run
   * form after the setup token is refused" — a live `role="alert"` on the same panel, from the one
   * failure first-run setup still has.
   */

  it('detects a genuinely broken fragment, so the audit is not vacuous', () => {
    const broken = document.createElement('div');
    broken.innerHTML = `
      <h1>One</h1><h1>Two</h1>
      <input type="text" />
      <button tabindex="3">Bad</button>
      <img src="x.png">
    `;
    const findings = auditA11y(broken);
    expect(findings).toContain('more than one <h1>');
    expect(findings).toContain('unlabelled form control: input');
    expect(findings).toContain('positive tabindex on: button');
    expect(findings).toContain('img with no alt attribute');
  });

  it('detects the quieter faults too', () => {
    const broken = document.createElement('div');
    broken.innerHTML = `
      <h1>Only one</h1>
      <p id="dup">a</p><p id="dup">b</p>
      <div aria-labelledby="nowhere">named by nothing</div>
      <label for="missing">Orphan label</label>
      <a href="https://example.com" target="_blank">Outbound</a>
      <button></button>
      <table><tr><th>No scope</th></tr></table>
      <h3>Jumped a level</h3>
      <div aria-hidden="true"><button>Reachable but hidden</button></div>
    `;
    const findings = auditA11y(broken);
    expect(findings).toContain('duplicate id: dup');
    expect(findings).toContain('aria-labelledby points at a missing id: nowhere');
    expect(findings).toContain('label[for] points at a missing id: missing');
    expect(findings).toContain('target=_blank without rel=noopener');
    expect(findings).toContain('button with no accessible name');
    expect(findings).toContain('th with no scope: No scope');
    expect(findings).toContain('heading level jumps from h1 to h3');
    expect(findings).toContain('focusable element inside aria-hidden: button');
  });

  /**
   * `role="grid"` is a COMPOSITE WIDGET role. It obliges the author to ship two-dimensional
   * arrow-key navigation over a roving tabindex, and it makes assistive technology announce the
   * thing as an interactive widget rather than as a table. Task 20 applied it to the calendar
   * month view — which has no such navigation, and whose only interactive contents are ordinary
   * links the browser already reaches with Tab — because its brief's queries asked for it.
   *
   * The audit now says so out loud, so the decision cannot silently regress.
   */
  it('refuses a grid role that ships no keyboard entry point', () => {
    const broken = document.createElement('div');
    broken.innerHTML = `
      <h1>Month</h1>
      <table role="grid"><tbody><tr><td role="gridcell">1</td></tr></tbody></table>
    `;
    expect(auditA11y(broken)).toContain('role="grid" with no focusable cell');
  });

  it('accepts a grid that really is keyboard navigable', () => {
    const ok = document.createElement('div');
    ok.innerHTML = `
      <h1>Month</h1>
      <table role="grid"><tbody><tr><td role="gridcell" tabindex="0">1</td></tr></tbody></table>
    `;
    expect(auditA11y(ok)).toEqual([]);
  });

  it('reports a page with no h1 at all, which reads as a fragment rather than a screen', () => {
    const headless = document.createElement('div');
    headless.innerHTML = '<h2>Second-level only</h2>';
    expect(auditA11y(headless)).toContain('no <h1>');
  });

  it('reports an aria-label that assistive technology throws away', () => {
    const ignored = document.createElement('div');
    ignored.innerHTML = '<h1>Rail</h1><span aria-label="3 unread notifications">3</span>';
    expect(auditA11y(ignored)).toContain(
      'aria-label on a generic <span>, which assistive technology ignores',
    );
  });

  it('accepts the same label once the element has a role that can carry it', () => {
    const named = document.createElement('div');
    named.innerHTML =
      '<h1>Rail</h1><span role="img" aria-label="3 unread notifications">3</span>';
    expect(auditA11y(named)).toEqual([]);
  });

  /** The frame every route renders inside. Its skip link and rail are audited nowhere else. */
  it('AppShell has no accessibility violations', () => {
    const { container } = render(
      <SessionContext.Provider value={SESSION}>
        <MemoryRouter>
          <AppShell>
            <h1>A page</h1>
          </AppShell>
        </MemoryRouter>
      </SessionContext.Provider>,
    );
    expect(auditA11y(container)).toEqual([]);
  });
});

/**
 * BEYOND THE AUTOMATED CHECKS.
 *
 * A page can pass every structural rule above and still tell a screen-reader user something
 * false. These four are the claims this product's content makes load-bearing, and each one has
 * already been got wrong somewhere in this repository's history.
 */
describe('what the product says, said accessibly', () => {
  it('never lets an unknown verdict announce as a soft “no”', async () => {
    mount(<Browse now={NOW} />, '/');
    await screen.findByRole('table', { name: /opportunities/i });

    const badge = screen.getByLabelText(/^Unknown, needs/);
    const spoken = `${badge.getAttribute('aria-label') ?? ''} ${badge.textContent ?? ''}`;
    expect(spoken).not.toMatch(/ineligible|not eligible|does not qualify|rejected|denied/i);

    // The framing is not left to a `title` tooltip, which is a DESCRIPTION rather than a name and
    // reaches neither a touch user nor several screen readers. It is real text on the page.
    expect(
      screen.getByText(/Unknown is not a "no"|Unknown is not a “no”/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/waiting on an answer rather than ruling you out/i)).toBeInTheDocument();
  });

  it('explains an unknown verdict on the detail page, where no census sentence stands beside it', async () => {
    mount(<Opportunity now={NOW} />, '/o/arrl-amateur-radio-grants');
    await screen.findByRole('heading', { level: 1, name: /ARRL Amateur Radio Grants/ });

    const panel = screen.getByRole('region', { name: /why this verdict is unknown/i });
    expect(panel).toHaveTextContent(/not a "no"|not a “no”/i);
    expect(panel).toHaveTextContent(/never ineligible/i);
    // "Waiting on", never "becomes an answer" — the matcher short-circuits per axis.
    expect(panel.textContent ?? '').not.toMatch(/becomes an answer|will resolve|resolves this/i);
  });

  /**
   * The live region and the heading describe THE SAME RECORD.
   *
   * The callsign lookup is the only control in this product that puts a value about the user on
   * screen without being told it, and callook answers a superseded callsign with the licensee's
   * CURRENT record — so the panel can open on a record for a callsign nobody typed. The visible
   * heading named that record; the announcement was built from the TYPED callsign, and told a
   * screen-reader user "FCC record for K9OLD: ALEX Q EXAMPLE" about a record that is W5NEW's. A
   * value swapped in under a user who cannot see the swap is the worst version of this product's
   * one recurring failure.
   */
  it('announces the FCC record that is on screen, not the callsign that was typed', async () => {
    const { container } = mount(<Profile />, '/profile');
    // The stored profile, not the loading state: both render a "Completeness" heading, and typing
    // into the form before it hydrates is typing into a box the response then overwrites.
    const callsign = await screen.findByDisplayValue('W1AW');
    await userEvent.clear(callsign);
    await userEvent.type(callsign, 'K9OLD');
    await userEvent.click(screen.getByRole('button', { name: /look up this callsign/i }));

    const heading = await screen.findByRole('heading', { name: /FCC record for/i });
    const live = container.querySelector('[aria-live="polite"]');
    expect(live).not.toBeNull();
    // Word for word: what is read out starts with what is on screen.
    expect(live?.textContent ?? '').toContain(heading.textContent ?? '');
    expect(live?.textContent ?? '').toMatch(/not the K9OLD you asked about/i);
    expect(live?.textContent ?? '').not.toMatch(/FCC record for K9OLD/i);
  });

  it('announces a projected date as projected, everywhere one is rendered', async () => {
    // Only 4 of the corpus's 244 cycles are funder-published. A projection read out as a plain
    // date is a promise nobody made.
    const browse = mount(<Browse now={NOW} />, '/');
    await screen.findByRole('table', { name: /opportunities/i });
    expect(screen.getByLabelText(/projected from a recurrence rule/i)).toBeInTheDocument();
    browse.unmount();

    const detail = mount(<Opportunity now={NOW} />, '/o/arrl-amateur-radio-grants');
    await screen.findByRole('heading', { level: 1, name: /ARRL Amateur Radio Grants/ });
    expect(screen.getByText(/projected, not observed/i)).toBeInTheDocument();
    detail.unmount();

    mount(<Calendar now={NOW} />, '/calendar');
    const agenda = await screen.findByRole('list', { name: /agenda/i });
    expect(within(agenda).getByText(/projected, not observed/i)).toBeInTheDocument();
    expect(within(agenda).getByText(/funder-published/i)).toBeInTheDocument();
  });

  it('never announces an unstated obligation as “not required”', async () => {
    mount(<Opportunity now={NOW} />, '/o/arrl-amateur-radio-grants');
    await screen.findByRole('heading', { level: 1, name: /ARRL Amateur Radio Grants/ });

    const obligations = screen.getByRole('region', { name: /obligations if you win/i });
    expect(obligations).toHaveTextContent(/not stated/i);
    expect(obligations.textContent ?? '').not.toMatch(/not required|no preference/i);
  });

  it('announces the safety-warning record as a warning and links the hijacked host nowhere', async () => {
    const browse = mount(<Browse now={NOW} />, '/');
    await screen.findByRole('table', { name: /opportunities/i });
    expect(screen.getByRole('note', { name: /safety warning/i })).toHaveTextContent(
      /do not visit it/i,
    );
    for (const link of screen.getAllByRole('link')) {
      expect(link.getAttribute('href') ?? '').not.toMatch(/farweb\.org|batualam\.org/);
    }
    browse.unmount();

    const watchlist = mount(<Watchlist now={NOW} />, '/watchlist');
    await screen.findByRole('table', { name: /watched programs/i });
    expect(screen.getByRole('note', { name: /safety warning/i })).toBeInTheDocument();
    for (const link of screen.getAllByRole('link')) {
      expect(link.getAttribute('href') ?? '').not.toMatch(/farweb\.org|batualam\.org/);
    }
    watchlist.unmount();

    // The Inbox candidate CARRIES the hijacked URL, which is the hardest case: the reviewer has
    // to see the address to judge the candidate, and must not be handed it as a link.
    mount(<Inbox />, '/inbox');
    await screen.findByRole('button', { name: /^approve$/i });
    const alerts = screen.getAllByRole('alert');
    expect(alerts.some((a) => /safety warning/i.test(a.textContent ?? ''))).toBe(true);
    expect(screen.getByText('https://www.farweb.org/scholarships')).toBeInTheDocument();
    for (const link of screen.getAllByRole('link')) {
      expect(link.getAttribute('href') ?? '').not.toMatch(/farweb\.org|batualam\.org/);
    }
  });
  /**
   * A TEST STOOD HERE AND IS DELETED RATHER THAN REWRITTEN, WHICH IS A LOSS AND IS SAID AS ONE.
   *
   * It was called "announces why a code was refused" and it drove the enrolment form to a 403
   * carrying `reason: 'expired'`, then asserted the sentence landed in a live region rather than
   * merely on screen. It was one of a pair — the other announced the one-time code the admin
   * console showed after issuing one — and both are about the same hazard: something appears that a
   * sighted user's eye is drawn to and a screen reader is told nothing about.
   *
   * Enrolment codes are retired (migration 095), so there is no expired code, no 403 carrying that
   * reason, and no admin panel to show a plaintext. Neither test can be pointed at anything.
   *
   * WHAT IS STILL WORTH ASSERTING AND IS NOT ASSERTED HERE: the sign-up form still has refusals a
   * person must be TOLD about rather than shown — a weak password, an address that already has an
   * account, a rate-limited attempt — and every one of them should be announced. The screens list
   * above still audits the form's resting state, which catches a missing label but not a missing
   * live region. Whoever owns the signed-out screens after this change should put that pair back
   * against the refusals the new form actually produces; writing it here, against labels and a
   * component shape that are being edited in parallel, would have pinned a form that does not exist
   * yet.
   */

});
