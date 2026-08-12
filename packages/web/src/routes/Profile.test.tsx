import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Profile } from './Profile.js';
import type { CompletenessReport, ProfileKind } from '../store/session.js';
import type { CallsignLookupResult, CallsignRecord } from '../api/callsign.js';
import { auditA11y } from '../test/a11y.js';

const PERSON_RECORD: CallsignRecord = {
  callsign: 'W8UM',
  type: 'PERSON',
  name: 'JANE Q OPERATOR',
  operClass: 'GENERAL',
  operClassRaw: 'GENERAL',
  addressLine1: '1301 BEAL AVE',
  city: 'ANN ARBOR',
  state: 'MI',
  zip: '48109',
  isPoBox: false,
  grantDate: '2019-04-04',
  frn: '0012345678',
  ulsUrl: 'https://wireless2.fcc.gov/UlsApp/UlsSearch/license.jsp?licKey=1234',
  source: 'callook.info',
  fetchedAt: '2026-08-04T12:00:00.000Z',
};

/** One of the ~212k legacy licences: ADVANCED maps onto none of core's four, so `operClass` is absent. */
const LEGACY_RECORD: CallsignRecord = {
  ...PERSON_RECORD,
  operClass: undefined,
  operClassRaw: 'ADVANCED',
};

/**
 * A record with nothing to say about the two fields a previous one filled: callook returned no
 * address it could parse a state out of, and the operator class is one of the legacy ones that map
 * onto none of GrantSpotter's four. Both halves are ordinary — a PO-box-only record and an
 * ADVANCED licence are not edge cases — and together they are what "the new record is silent"
 * looks like in the wild.
 */
const SILENT_RECORD: CallsignRecord = {
  ...PERSON_RECORD,
  operClass: undefined,
  operClassRaw: 'ADVANCED',
  addressLine1: undefined,
  city: undefined,
  state: undefined,
  zip: undefined,
};

const CLUB_RECORD: CallsignRecord = {
  callsign: 'W8UM',
  type: 'CLUB',
  name: 'UNIVERSITY OF MICHIGAN AMATEUR RADIO CLUB',
  city: 'ANN ARBOR',
  state: 'MI',
  isPoBox: false,
  source: 'callook.info',
  fetchedAt: '2026-08-04T12:00:00.000Z',
};

const STUDENT_REPORT: CompletenessReport = {
  total: 5,
  unknownCount: 2,
  score: 60,
  fields: [
    { field: 'gpa', resolves: 2 },
    { field: 'citizenship', resolves: 1 },
  ],
};

const ORG_REPORT: CompletenessReport = {
  total: 5,
  unknownCount: 3,
  score: 40,
  fields: [{ field: 'state', resolves: 3 }],
};

interface ProfilesBody {
  student: Record<string, unknown> | null;
  organization: Record<string, unknown> | null;
  completenessFor: ProfileKind | null;
  completeness: CompletenessReport;
}

const SAVED_STUDENT = {
  kind: 'student',
  callsign: 'W8UM',
  licenseClass: 'GENERAL',
  state: 'MI',
  stage: 'UNDERGRAD',
};

const PROFILES: ProfilesBody = {
  student: SAVED_STUDENT,
  organization: null,
  completenessFor: 'student',
  completeness: STUDENT_REPORT,
};

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

/**
 * One stub for both calls the route makes. The PUT reply echoes the kind that was
 * saved, exactly as `profileRouter.ts` does — that echo is what moves the meter
 * from one profile to the other, so a stub that hardcoded `student` would hide the
 * selector this task exists to build.
 *
 * `getFor` is query-aware: a GET whose URL carries `?profile=<kind>` (the same
 * parameter 2a1a9c3 added to the real route) answers with `getFor[kind]` when the
 * test supplied one, and falls back to `get` otherwise — so every existing test
 * that never passes `getFor` keeps seeing one fixed response regardless of query,
 * exactly as before.
 */
function stubFetch(
  options: {
    get?: ProfilesBody;
    getFor?: Partial<Record<ProfileKind, ProfilesBody>>;
    putReport?: CompletenessReport;
    /** The answer `POST /api/callsign/lookup` gives, for the tests that press the button. */
    lookup?: CallsignLookupResult;
    /**
     * One answer per press, for the tests that look a second callsign up. The last entry is
     * repeated once the queue runs out, so a test only has to name the answers it cares about.
     */
    lookups?: CallsignLookupResult[];
  } = {},
) {
  const queued = [...(options.lookups ?? [])];
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url === '/api/callsign/lookup') {
      const next = queued.length > 1 ? queued.shift() : queued[0];
      return Promise.resolve(
        jsonResponse(
          next ?? options.lookup ?? { status: 'unavailable', message: 'No stub was supplied.' },
        ),
      );
    }
    if ((init?.method ?? 'GET') === 'PUT') {
      const sent = JSON.parse(String(init?.body)) as { kind: ProfileKind };
      return Promise.resolve(
        jsonResponse({
          profile: sent,
          completenessFor: sent.kind,
          completeness:
            options.putReport ?? (sent.kind === 'student' ? STUDENT_REPORT : ORG_REPORT),
        }),
      );
    }
    const match = /[?&]profile=(student|organization)\b/.exec(url);
    const forKind = match?.[1] as ProfileKind | undefined;
    const body = (forKind !== undefined ? options.getFor?.[forKind] : undefined) ?? options.get ?? PROFILES;
    return Promise.resolve(jsonResponse(body));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function putCall(fetchMock: ReturnType<typeof stubFetch>): [string, RequestInit] | undefined {
  return fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'PUT') as
    | [string, RequestInit]
    | undefined;
}

function putBody(fetchMock: ReturnType<typeof stubFetch>): Record<string, unknown> {
  const call = putCall(fetchMock);
  if (call === undefined) throw new Error('no PUT was sent');
  return JSON.parse(String(call[1].body)) as Record<string, unknown>;
}

beforeEach(() => {
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderProfile(initial = '/profile') {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Profile />
    </MemoryRouter>,
  );
}

/**
 * Render and wait for the report to arrive. The meter is the signal because it does not
 * exist before then: an empty meter rendered while the request is in flight would claim
 * 0% for a profile nobody has measured yet, and awaiting it would prove nothing.
 */
async function renderLoaded(initial = '/profile') {
  const result = renderProfile(initial);
  await screen.findByRole('meter', { name: /profile completeness/i });
  return result;
}

describe('Profile', () => {
  it('offers both a student and an organization editor', async () => {
    renderProfile();
    expect(await screen.findByRole('tab', { name: /student/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /organization/i })).toBeInTheDocument();
  });

  // The inputs render before the fetch resolves — that is what lets a `?focus=` jump land
  // on the right field immediately — so the saved values arrive on a later commit.
  it('loads the saved student values into the form', async () => {
    renderProfile();
    await waitFor(() => expect(screen.getByLabelText(/callsign/i)).toHaveValue('W8UM'));
    expect(screen.getByLabelText(/license class/i)).toHaveValue('GENERAL');
    expect(screen.getByLabelText(/^stage$/i)).toHaveValue('UNDERGRAD');
  });

  it('renders the completeness meter in terms of unknown verdicts, not fields filled', async () => {
    await renderLoaded();
    const meter = screen.getByRole('meter', { name: /profile completeness/i });
    expect(meter).toHaveAttribute('aria-valuenow', '60');
    expect(meter).toHaveAttribute('aria-valuemax', '100');
    expect(
      screen.getByText(/2 of 5 programs still return an unknown verdict/i),
    ).toBeInTheDocument();
  });

  it('names the profile the one meter speaks for', async () => {
    await renderLoaded();
    expect(screen.getByText(/measured against your student profile/i)).toBeInTheDocument();
  });

  it('ranks what the unknown verdicts are waiting on, highest first', async () => {
    await renderLoaded();
    const ladder = screen.getByRole('region', {
      name: /what your unknown verdicts are waiting on/i,
    });
    const items = within(ladder).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent(/GPA/);
    expect(items[0]).toHaveTextContent(/2 unknown verdicts are waiting on this/i);
    expect(items[1]).toHaveTextContent(/1 unknown verdict is waiting on this/i);
  });

  it('links a waiting-on field to the input that sets it, on the tab that owns it', async () => {
    await renderLoaded();
    const ladder = screen.getByRole('region', {
      name: /what your unknown verdicts are waiting on/i,
    });
    expect(within(ladder).getByRole('link', { name: 'GPA' })).toHaveAttribute(
      'href',
      '/profile?kind=student&focus=gpa#field-gpa',
    );
  });

  /**
   * The copy rule for this screen, pinned. `resolves` is an UPPER BOUND: the matcher
   * short-circuits per axis, so answering a field can move a verdict from one unknown to a
   * different unknown. The meter may say a verdict is "waiting on" a field. It may not say
   * the field resolves it.
   */
  it('never promises that answering a field turns an unknown into an answer', async () => {
    await renderLoaded();
    const text = document.body.textContent ?? '';
    for (const forbidden of [
      /becomes? an answer/i,
      /will resolve/i,
      /resolve[sd]? \d+ unknown/i,
      /never turns into/i,
      /guarantee/i,
    ]) {
      expect(text).not.toMatch(forbidden);
    }
    expect(text).toMatch(/waiting on/i);
    // Task 18's framing, reused rather than reinvented: an unset field yields `unknown`,
    // never `ineligible` — which is not the same as promising it never becomes a "no".
    expect(text).toMatch(/An unanswered field is a question, not a/i);
  });

  it('explains what an ARRL Section is where geography is collected', async () => {
    await renderLoaded();
    expect(
      screen.getByText(
        /an ARRL Section is an ARRL-defined region that does not line up with state borders/i,
      ),
    ).toBeInTheDocument();
  });

  it('focuses the field named by ?focus= so a jump from an unknown verdict lands right', async () => {
    renderProfile('/profile?kind=student&focus=gpa');
    await waitFor(() => expect(screen.getByLabelText(/^GPA$/i)).toHaveFocus());
  });

  it('opens the organization tab for an organization field, not the student one', async () => {
    renderProfile('/profile?kind=organization&focus=state');
    await waitFor(() => expect(screen.getByLabelText(/^state$/i)).toHaveFocus());
    expect(screen.getByRole('tab', { name: /organization/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // Proof it is the ORGANIZATION state input: the student-only fields are not rendered.
    expect(screen.queryByLabelText(/^GPA$/i)).not.toBeInTheDocument();
  });

  it('does not steal focus back while the user types in another field', async () => {
    renderProfile('/profile?kind=student&focus=gpa');
    await waitFor(() => expect(screen.getByLabelText(/^GPA$/i)).toHaveFocus());
    const callsign = screen.getByLabelText(/callsign/i);
    await userEvent.clear(callsign);
    await userEvent.type(callsign, 'K5UTD');
    expect(callsign).toHaveFocus();
  });

  it('saves the student profile as a PUT with the matching kind', async () => {
    const fetchMock = stubFetch();
    await renderLoaded();
    await userEvent.clear(screen.getByLabelText(/callsign/i));
    await userEvent.type(screen.getByLabelText(/callsign/i), 'K5UTD');
    await userEvent.click(screen.getByRole('button', { name: /save student profile/i }));
    await waitFor(() => {
      expect(putCall(fetchMock)?.[0]).toBe('/api/profiles/student');
    });
    expect(putBody(fetchMock)).toMatchObject({ kind: 'student', callsign: 'K5UTD' });
  });

  it('omits empty optional fields from the payload rather than sending empty strings', async () => {
    const fetchMock = stubFetch({
      get: { student: { kind: 'student' }, organization: null, completenessFor: 'student', completeness: STUDENT_REPORT },
    });
    await renderLoaded();
    await userEvent.click(screen.getByRole('button', { name: /save student profile/i }));
    await waitFor(() => expect(putCall(fetchMock)).toBeDefined());
    const body = putBody(fetchMock);
    expect(body).not.toHaveProperty('callsign');
    expect(Object.values(body)).not.toContain('');
  });

  it('sends numbers as numbers, not strings', async () => {
    const fetchMock = stubFetch();
    await renderLoaded();
    await userEvent.type(screen.getByLabelText(/^GPA$/i), '3.4');
    await userEvent.click(screen.getByRole('button', { name: /save student profile/i }));
    await waitFor(() => expect(putCall(fetchMock)).toBeDefined());
    expect(putBody(fetchMock).gpa).toBe(3.4);
  });

  /**
   * A tri-state select, because "no" and "not said" are different answers. An unset field
   * yields `unknown`; a stated `false` is an answer the matcher may act on. Collapsing them
   * into a checkbox would send `false` for every box the user never looked at.
   */
  it('distinguishes an unanswered boolean from an answered "no"', async () => {
    const fetchMock = stubFetch();
    await renderLoaded();
    await userEvent.selectOptions(screen.getByLabelText(/financial need/i), 'false');
    await userEvent.click(screen.getByRole('button', { name: /save student profile/i }));
    await waitFor(() => expect(putCall(fetchMock)).toBeDefined());
    const body = putBody(fetchMock);
    expect(body.financialNeed).toBe(false);
    expect(body).not.toHaveProperty('accredited');
  });

  it('sends ham activity as an array of enum values', async () => {
    const fetchMock = stubFetch();
    await renderLoaded();
    await userEvent.click(screen.getByRole('checkbox', { name: /field day/i }));
    await userEvent.click(screen.getByRole('checkbox', { name: /contesting/i }));
    await userEvent.click(screen.getByRole('button', { name: /save student profile/i }));
    await waitFor(() => expect(putCall(fetchMock)).toBeDefined());
    expect(putBody(fetchMock).activityKinds).toEqual(['field_day', 'contesting']);
  });

  it('switches to the organization editor and saves that kind', async () => {
    const fetchMock = stubFetch();
    await renderLoaded();
    await userEvent.click(screen.getByRole('tab', { name: /organization/i }));
    await userEvent.selectOptions(screen.getByLabelText(/entity type/i), 'club_501c3');
    await userEvent.type(screen.getByLabelText(/organization name/i), 'Example University ARC');
    await userEvent.click(screen.getByRole('button', { name: /save organization profile/i }));
    await waitFor(() => expect(putCall(fetchMock)?.[0]).toBe('/api/profiles/organization'));
    expect(putBody(fetchMock)).toMatchObject({
      kind: 'organization',
      entity: 'club_501c3',
      orgName: 'Example University ARC',
    });
  });

  /**
   * `orgProfileSchema.entity` is REQUIRED — the only required field on either profile. A form
   * that lets the user press save without it earns a 422 every time.
   */
  it('refuses to save an organization profile with no entity type, and sends nothing', async () => {
    const fetchMock = stubFetch();
    await renderLoaded();
    await userEvent.click(screen.getByRole('tab', { name: /organization/i }));
    await userEvent.click(screen.getByRole('button', { name: /save organization profile/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/entity type/i);
    expect(putCall(fetchMock)).toBeUndefined();
  });

  it('does not send student fields when saving the organization profile', async () => {
    const fetchMock = stubFetch();
    await renderLoaded();
    await userEvent.type(screen.getByLabelText(/^GPA$/i), '3.4');
    await userEvent.click(screen.getByRole('tab', { name: /organization/i }));
    await userEvent.selectOptions(screen.getByLabelText(/entity type/i), 'school_lea');
    await userEvent.click(screen.getByRole('button', { name: /save organization profile/i }));
    await waitFor(() => expect(putCall(fetchMock)).toBeDefined());
    expect(putBody(fetchMock)).not.toHaveProperty('gpa');
  });

  it('keeps unsaved edits when the user switches tabs and comes back', async () => {
    await renderLoaded();
    await userEvent.type(screen.getByLabelText(/^GPA$/i), '3.4');
    await userEvent.click(screen.getByRole('tab', { name: /organization/i }));
    await userEvent.click(screen.getByRole('tab', { name: /student/i }));
    expect(screen.getByLabelText(/^GPA$/i)).toHaveValue(3.4);
  });

  it('confirms the save in a live region', async () => {
    await renderLoaded();
    await userEvent.click(screen.getByRole('button', { name: /save student profile/i }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/saved/i));
  });

  // ---- the selector for a user who holds both profiles ----

  it('opens the tab the server says the meter speaks for, not a hardcoded default', async () => {
    stubFetch({
      get: {
        student: null,
        organization: { kind: 'organization', entity: 'club_501c3' },
        completenessFor: 'organization',
        completeness: ORG_REPORT,
      },
    });
    renderProfile();
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /organization/i })).toHaveAttribute(
        'aria-selected',
        'true',
      ),
    );
    expect(screen.getByText(/measured against your organization profile/i)).toBeInTheDocument();
  });

  it('says the meter is silent about the other profile a dual-profile user holds', async () => {
    stubFetch({
      get: {
        student: SAVED_STUDENT,
        organization: { kind: 'organization', entity: 'club_501c3' },
        completenessFor: 'student',
        completeness: STUDENT_REPORT,
      },
    });
    renderProfile();
    expect(
      await screen.findByText(/your organization profile has not been measured/i),
    ).toBeInTheDocument();
  });

  it('warns while the user edits the profile the meter does not speak for', async () => {
    stubFetch({
      get: {
        student: SAVED_STUDENT,
        organization: { kind: 'organization', entity: 'club_501c3' },
        completenessFor: 'student',
        completeness: STUDENT_REPORT,
      },
    });
    await renderLoaded();
    await userEvent.click(screen.getByRole('tab', { name: /organization/i }));
    expect(
      screen.getByText(/this meter does not speak for the organization profile you are editing/i),
    ).toBeInTheDocument();
  });

  it('moves the meter to the profile just saved, using the kind the server echoed', async () => {
    stubFetch({
      get: {
        student: SAVED_STUDENT,
        organization: { kind: 'organization', entity: 'club_501c3' },
        completenessFor: 'student',
        completeness: STUDENT_REPORT,
      },
    });
    await renderLoaded();
    await userEvent.click(screen.getByRole('tab', { name: /organization/i }));
    await userEvent.click(screen.getByRole('button', { name: /save organization profile/i }));
    await waitFor(() =>
      expect(screen.getByText(/measured against your organization profile/i)).toBeInTheDocument(),
    );
    expect(screen.getByRole('meter', { name: /profile completeness/i })).toHaveAttribute(
      'aria-valuenow',
      '40',
    );
    expect(
      screen.getByText(/3 of 5 programs still return an unknown verdict/i),
    ).toBeInTheDocument();
  });

  /**
   * The gap this task closes: before, a dual-profile user could only ever see the
   * organization meter by SAVING over it, because the PUT reply was the only response
   * that ever named a non-priority profile. 2a1a9c3 gave `GET /api/profiles` a
   * `?profile=` parameter for exactly this; this is the UI actually using it.
   */
  it('shows the organization profile its own meter after a tab switch, with no save', async () => {
    const fetchMock = stubFetch({
      get: {
        student: SAVED_STUDENT,
        organization: { kind: 'organization', entity: 'club_501c3' },
        completenessFor: 'student',
        completeness: STUDENT_REPORT,
      },
      getFor: {
        organization: {
          student: SAVED_STUDENT,
          organization: { kind: 'organization', entity: 'club_501c3' },
          completenessFor: 'organization',
          completeness: ORG_REPORT,
        },
      },
    });
    await renderLoaded();
    expect(screen.getByText(/measured against your student profile/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: /organization/i }));
    await waitFor(() =>
      expect(screen.getByText(/measured against your organization profile/i)).toBeInTheDocument(),
    );
    expect(screen.getByRole('meter', { name: /profile completeness/i })).toHaveAttribute(
      'aria-valuenow',
      '40',
    );
    expect(
      screen.getByText(/3 of 5 programs still return an unknown verdict/i),
    ).toBeInTheDocument();
    // The meter now speaks for organization, so it is STUDENT that is unevaluated —
    // the label follows the meter, it is never both at once.
    expect(screen.getByText(/your student profile has not been measured/i)).toBeInTheDocument();

    // No PUT was ever sent: the meter moved without saving anything.
    expect(fetchMock.mock.calls.every((c) => (c[1] as RequestInit | undefined)?.method !== 'PUT')).toBe(
      true,
    );
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/profiles?profile=organization')),
    ).toBe(true);
  });

  it('preserves an unsaved draft in the tab left behind, across the refetch a tab switch triggers', async () => {
    stubFetch({
      get: {
        student: SAVED_STUDENT,
        organization: { kind: 'organization', entity: 'club_501c3' },
        completenessFor: 'student',
        completeness: STUDENT_REPORT,
      },
      getFor: {
        organization: {
          student: SAVED_STUDENT,
          organization: { kind: 'organization', entity: 'club_501c3' },
          completenessFor: 'organization',
          completeness: ORG_REPORT,
        },
        student: {
          student: SAVED_STUDENT,
          organization: { kind: 'organization', entity: 'club_501c3' },
          completenessFor: 'student',
          completeness: STUDENT_REPORT,
        },
      },
    });
    await renderLoaded();

    // Edit the student tab, then leave it via a switch that triggers a background refetch.
    await userEvent.clear(screen.getByLabelText(/callsign/i));
    await userEvent.type(screen.getByLabelText(/callsign/i), 'K5UTD');
    await userEvent.click(screen.getByRole('tab', { name: /organization/i }));
    await waitFor(() =>
      expect(screen.getByText(/measured against your organization profile/i)).toBeInTheDocument(),
    );

    // Edit the organization tab too, then switch back — another refetch fires.
    await userEvent.type(screen.getByLabelText(/organization name/i), 'Example University ARC');
    await userEvent.click(screen.getByRole('tab', { name: /student/i }));
    await waitFor(() =>
      expect(screen.getByText(/measured against your student profile/i)).toBeInTheDocument(),
    );
    expect(screen.getByLabelText(/callsign/i)).toHaveValue('K5UTD');

    // And the organization draft survived that second refetch too.
    await userEvent.click(screen.getByRole('tab', { name: /organization/i }));
    await waitFor(() =>
      expect(screen.getByText(/measured against your organization profile/i)).toBeInTheDocument(),
    );
    expect(screen.getByLabelText(/organization name/i)).toHaveValue('Example University ARC');
  });

  /**
   * The empty-form hole Task 22 found: saving a form that failed to load would replace a
   * complete stored profile with nothing. That gate (`loadError !== null && !loaded`, and
   * the submit button's `disabled={saving || !loaded}`) is wired to the FIRST load only.
   * A background meter refetch that fails must not be able to reopen it.
   */
  it('does not disable saving or touch the loaded draft when a background meter refetch fails', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'PUT') return Promise.reject(new Error('save should not have been called'));
      if (String(url).includes('profile=organization')) {
        return Promise.reject(new TypeError('Failed to fetch'));
      }
      return Promise.resolve(
        jsonResponse({
          student: SAVED_STUDENT,
          organization: { kind: 'organization', entity: 'club_501c3' },
          completenessFor: 'student',
          completeness: STUDENT_REPORT,
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await renderLoaded();
    await userEvent.click(screen.getByRole('tab', { name: /organization/i }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('profile=organization'))).toBe(
        true,
      ),
    );

    // The failed background refetch shows no alert of its own, and does not disable Save —
    // the organization tab's own data (already in `drafts` from the first, successful load)
    // is still there to save.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save organization profile/i })).not.toBeDisabled();

    // The student tab, and its already-loaded draft, are untouched by the failure too.
    await userEvent.click(screen.getByRole('tab', { name: /student/i }));
    expect(screen.getByLabelText(/callsign/i)).toHaveValue('W8UM');
    expect(screen.getByRole('button', { name: /save student profile/i })).not.toBeDisabled();
  });

  /**
   * The `held[kind]` guard on `needsMeterRefetch`, pinned. Both tabs are always in the DOM no
   * matter what the user holds, so a user with only a student profile can click the
   * organization tab even though nothing was ever saved there. Without `held[kind]`, that click
   * alone would ask the server for `?profile=organization` anyway; the real route
   * (`profileRouter.ts`) answers a `prefer` the caller does not hold exactly like the
   * holds-nothing case — `completenessFor: null` and an empty report — and the effect that reads
   * `meterData` would paint that straight over the correctly-measured 60%-complete student
   * profile, which is not even the tab now open. `report`/`measuredFor` never feed `save()`
   * (that reads only `drafts[kind]`), so this could not itself overwrite the STORED profile —
   * but it is exactly the "0%, not measured" claim made from ignorance about a profile that
   * really is measured that every other surface in this product refuses to make, and it does
   * not even announce itself: the same guard fires a real refetch on the way back to the
   * student tab and quietly repaints the right number, so only a user who never flips back
   * would ever see the wrong meter.
   */
  it("does not let a click on an unheld tab null out the other profile's real measurement", async () => {
    const EMPTY_REPORT: CompletenessReport = { total: 5, unknownCount: 5, score: 0, fields: [] };
    const fetchMock = stubFetch({
      get: {
        student: SAVED_STUDENT,
        organization: null,
        completenessFor: 'student',
        completeness: STUDENT_REPORT,
      },
      getFor: {
        // The real server's answer to a `?profile=` the caller does not hold: `loadActiveProfile`
        // given a `prefer` not on file returns null, the same as the no-preference/holds-nothing
        // case (profileRouter.ts).
        organization: {
          student: SAVED_STUDENT,
          organization: null,
          completenessFor: null,
          completeness: EMPTY_REPORT,
        },
      },
    });
    await renderLoaded();
    expect(screen.getByText(/measured against your student profile/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: /organization/i }));

    // No refetch was ever asked for a profile the user does not hold...
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).includes('profile=organization')),
    ).toBe(false);
    // ...so the meter is still telling the truth about the profile it actually measured, even
    // though the open tab is now the one it does not speak for.
    expect(screen.getByText(/measured against your student profile/i)).toBeInTheDocument();
    expect(screen.getByRole('meter', { name: /profile completeness/i })).toHaveAttribute(
      'aria-valuenow',
      '60',
    );
  });

  it('says so when no profile has been measured at all', async () => {
    stubFetch({
      get: {
        student: null,
        organization: null,
        completenessFor: null,
        completeness: { total: 5, unknownCount: 5, score: 0, fields: [] },
      },
    });
    renderProfile();
    expect(await screen.findByText(/no profile has been measured yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/measured against your/i)).not.toBeInTheDocument();
  });

  // ---- failure modes ----

  /**
   * The meter must not exist before there is a report. An empty one rendered while the
   * request is in flight reads "0%. No profile has been measured yet." to a user whose
   * profile scores 92 — a claim made from ignorance, which is the defect class this
   * product exists to avoid.
   */
  it('claims no score at all while the report is still loading', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));
    renderProfile();
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
    expect(screen.queryByText(/no profile has been measured yet/i)).not.toBeInTheDocument();
    expect(screen.getByText(/measuring your profile against the corpus/i)).toBeInTheDocument();
  });

  /**
   * The inputs render before the request returns, so a failed load leaves a form full of
   * empty boxes the user never emptied. Saving that would replace the stored profile with
   * nothing.
   */
  it('refuses to save over a profile it could not load, and says why', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.reject(new TypeError('Failed to fetch')),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderProfile();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /saved profile could not be loaded/i,
    );
    expect(screen.getByRole('button', { name: /save student profile/i })).toBeDisabled();
    expect(fetchMock.mock.calls.every((c) => (c[1] as RequestInit | undefined)?.method !== 'PUT')).toBe(
      true,
    );
  });

  it('reports an unreachable API as unreachable, not as a rejected value', async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'PUT') return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.resolve(jsonResponse(PROFILES));
    });
    vi.stubGlobal('fetch', fetchMock);
    await renderLoaded();
    await userEvent.click(screen.getByRole('button', { name: /save student profile/i }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not be reached/i);
    expect(alert).not.toHaveTextContent(/not accepted|rejected/i);
  });

  it('reports a validation refusal as a validation refusal', async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'PUT') {
        return Promise.resolve({
          ok: false,
          status: 422,
          json: async () => ({
            error: { code: 'validation_failed', message: 'Profile failed validation.' },
            requestId: 'req-1',
          }),
        } as unknown as Response);
      }
      return Promise.resolve(jsonResponse(PROFILES));
    });
    vi.stubGlobal('fetch', fetchMock);
    await renderLoaded();
    await userEvent.click(screen.getByRole('button', { name: /save student profile/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/not accepted/i);
  });
});

/**
 * THE LOOKUP, ON THE SCREEN THAT STORES WHAT IT FINDS.
 *
 * The component's own suite proves what the panel says. These prove what the FORM does with
 * it: that nothing moves until the user presses the button, that what moves is marked as
 * something GrantSpotter read rather than something they said, and that the mark comes off
 * the moment they take a field over.
 */
describe('filling the profile from the FCC record', () => {
  async function lookUpAndAccept(): Promise<void> {
    await userEvent.click(screen.getByRole('button', { name: /look up this callsign/i }));
    await userEvent.click(await screen.findByRole('button', { name: /use these values/i }));
  }

  it('offers the lookup beside the callsign field', async () => {
    await renderLoaded();
    expect(screen.getByRole('button', { name: /look up this callsign/i })).toBeInTheDocument();
  });

  it('changes nothing until the user accepts the record', async () => {
    stubFetch({ lookup: { status: 'found', record: PERSON_RECORD } });
    await renderLoaded();
    await userEvent.clear(screen.getByLabelText(/callsign/i));
    await userEvent.type(screen.getByLabelText(/callsign/i), 'K5UTD');
    await userEvent.click(screen.getByRole('button', { name: /look up this callsign/i }));

    await screen.findByRole('button', { name: /use these values/i });
    // The record on screen says W8UM. The form still says what the user typed.
    expect(screen.getByLabelText(/callsign/i)).toHaveValue('K5UTD');
    expect(screen.getByLabelText(/^state$/i)).toHaveValue('MI');

    await userEvent.click(screen.getByRole('button', { name: /discard/i }));
    expect(screen.getByLabelText(/callsign/i)).toHaveValue('K5UTD');
  });

  it('fills the fields it has somewhere to put, and marks every one of them', async () => {
    stubFetch({ lookup: { status: 'found', record: PERSON_RECORD } });
    await renderLoaded();
    await lookUpAndAccept();

    expect(screen.getByLabelText(/callsign/i)).toHaveValue('W8UM');
    expect(screen.getByLabelText(/^state$/i)).toHaveValue('MI');
    expect(screen.getByLabelText(/license class/i)).toHaveValue('GENERAL');
    // Never, from a grant date that resets on renewal.
    expect(screen.getByLabelText(/licensed since/i)).toHaveValue('');

    const banner = screen.getByText(/marked fields below were read from/i);
    expect(banner).toHaveTextContent('callook.info');
    expect(banner).toHaveTextContent('2026-08-04');
    expect(screen.getByRole('link', { name: /check this record in the FCC ULS/i })).toHaveAttribute(
      'href',
      PERSON_RECORD.ulsUrl,
    );

    /**
     * One mark per field the lookup ANSWERED, and each one is part of its input's description
     * rather than decoration floating beside it. The callsign is not among them: it is the
     * question the user asked rather than an answer this tool found, and core's
     * `StudentFieldSources` has no room to store a marker for it — a mark shown here and
     * stripped on save would be worse than none.
     */
    expect(screen.getAllByText(/not a value you stated/i)).toHaveLength(2);
    expect(screen.getByLabelText(/^state$/i).getAttribute('aria-describedby')).toContain(
      'field-state-lookup',
    );
    expect(screen.getByLabelText(/callsign/i).getAttribute('aria-describedby')).not.toContain(
      'lookup',
    );
  });

  /**
   * The fields the FCC record has something adjacent to, and wrong, for. `licensedSince` feeds
   * `heldMonthsMin` in the matcher and the record's date resets on every renewal; the record
   * carries no county at all. Both sentences come from the field registry, so the editor and
   * the schema cannot drift apart about which fields a lookup may fill.
   */
  it('says why it left the fields alone that it will never fill', async () => {
    stubFetch({ lookup: { status: 'found', record: PERSON_RECORD } });
    await renderLoaded();
    // Nothing to explain before a lookup has happened.
    expect(screen.queryByText(/not the date you were first licensed/i)).not.toBeInTheDocument();

    await lookUpAndAccept();

    expect(screen.getByText(/not the date you were first licensed/i)).toBeInTheDocument();
    expect(screen.getByText(/no county at all/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/licensed since/i).getAttribute('aria-describedby')).toContain(
      'field-licensedSince-lookup',
    );
  });

  it('takes the mark off a field the moment the user edits it', async () => {
    const fetchMock = stubFetch({ lookup: { status: 'found', record: PERSON_RECORD } });
    await renderLoaded();
    await lookUpAndAccept();

    await userEvent.clear(screen.getByLabelText(/^state$/i));
    await userEvent.type(screen.getByLabelText(/^state$/i), 'CA');

    expect(screen.getAllByText(/not a value you stated/i)).toHaveLength(1);
    expect(screen.getByLabelText(/^state$/i).getAttribute('aria-describedby')).not.toContain(
      'field-state-lookup',
    );
    // The licence class is still GrantSpotter's, so the banner stays.
    expect(screen.getByText(/marked fields below were read from/i)).toBeInTheDocument();

    // And the marker for the value the user typed over is not stored either: a stale marker in
    // the database is a claim waiting to be read by something that does not check it.
    await userEvent.click(screen.getByRole('button', { name: /save student profile/i }));
    await waitFor(() => expect(putCall(fetchMock)).toBeDefined());
    const sources = putBody(fetchMock).fieldSources as Record<string, unknown>;
    expect(sources).toHaveProperty('licenseClass');
    expect(sources).not.toHaveProperty('state');
  });

  /**
   * The provenance is STORED, not a badge that lives for one minute in a component. A licence
   * class a lookup wrote is still distinguishable from one the applicant typed on the next
   * visit — which is the whole point of putting it in the profile rather than in a variable.
   */
  it('marks a value an earlier lookup wrote, on a profile loaded fresh from the server', async () => {
    stubFetch({
      get: {
        student: {
          ...SAVED_STUDENT,
          fieldSources: {
            licenseClass: {
              source: 'callook.info',
              fetchedAt: '2026-08-04T12:00:00.000Z',
              value: 'GENERAL',
            },
          },
        },
        organization: null,
        completenessFor: 'student',
        completeness: STUDENT_REPORT,
      },
    });
    await renderLoaded();

    expect(screen.getByText(/marked fields below were read from/i)).toHaveTextContent('2026-08-04');
    expect(screen.getAllByText(/not a value you stated/i)).toHaveLength(1);
    // The state was typed by the applicant on that same profile, and stays theirs.
    expect(screen.getByLabelText(/^state$/i).getAttribute('aria-describedby')).not.toContain(
      'field-state-lookup',
    );
  });

  it('saves the accepted values through the same Save button as any other edit', async () => {
    const fetchMock = stubFetch({ lookup: { status: 'found', record: PERSON_RECORD } });
    await renderLoaded();
    await lookUpAndAccept();

    // Accepting saved nothing by itself.
    expect(putCall(fetchMock)).toBeUndefined();

    await userEvent.click(screen.getByRole('button', { name: /save student profile/i }));
    await waitFor(() => expect(putCall(fetchMock)).toBeDefined());
    const body = putBody(fetchMock);
    expect(body).toMatchObject({
      kind: 'student',
      callsign: 'W8UM',
      state: 'MI',
      licenseClass: 'GENERAL',
    });
    // The street was on screen and is not in the payload, because there is nowhere for it to go.
    expect(JSON.stringify(body)).not.toContain('BEAL');
    expect(body).not.toHaveProperty('licensedSince');
  });

  it('puts a club station’s name on the organization profile', async () => {
    const fetchMock = stubFetch({ lookup: { status: 'found', record: CLUB_RECORD } });
    await renderLoaded();
    await userEvent.click(screen.getByRole('tab', { name: /organization/i }));
    await userEvent.type(screen.getByLabelText(/callsign/i), 'W8UM');
    await lookUpAndAccept();

    expect(screen.getByLabelText(/organization name/i)).toHaveValue(
      'UNIVERSITY OF MICHIGAN AMATEUR RADIO CLUB',
    );
    expect(screen.getByLabelText(/callsign/i)).toHaveValue('W8UM');

    // `entity` is still the user's to answer: a club licence does not say which kind of
    // applicant this is, so the lookup does not pretend to know.
    await userEvent.click(screen.getByRole('button', { name: /save organization profile/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/entity type/i);
    expect(putCall(fetchMock)).toBeUndefined();
  });

  /**
   * THE EDIT INSIDE THE PANEL IS THE APPLICANT'S, ALL THE WAY INTO THE DATABASE.
   *
   * A legacy licence class maps onto none of GrantSpotter's four, so the panel opens the select
   * UNSET and asks the applicant to choose — and the value they choose used to be saved with
   * callook.info's name on it. Nothing downstream could then tell an FCC-stated licence class from
   * one the applicant picked, and eligibility is computed from that field. Measured over the
   * 143-record publishable seed corpus (2026-08-04), the falsely attributed class moved 76 verdicts,
   * 13 of them onto a hard `{ kind: 'eligible' }`.
   */
  it('does not put the source’s name on a licence class the applicant picked', async () => {
    const fetchMock = stubFetch({ lookup: { status: 'found', record: LEGACY_RECORD } });
    await renderLoaded();
    await userEvent.click(screen.getByRole('button', { name: /look up this callsign/i }));

    // The panel says the record's own word for the class, and chooses nothing from it.
    expect(await screen.findByText(/nothing has been chosen for you/i)).toHaveTextContent(
      'ADVANCED',
    );
    await userEvent.selectOptions(screen.getByLabelText(/license class to fill in/i), 'EXTRA');
    await userEvent.click(screen.getByRole('button', { name: /use these values/i }));

    // The value is on the form, and it is the applicant's own answer.
    expect(screen.getByLabelText(/license class/i)).toHaveValue('EXTRA');
    expect(screen.getByLabelText(/license class/i).getAttribute('aria-describedby')).not.toContain(
      'field-licenseClass-lookup',
    );
    // The state IS the record's, so exactly one field is marked and the banner still stands.
    expect(screen.getAllByText(/not a value you stated/i)).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: /save student profile/i }));
    await waitFor(() => expect(putCall(fetchMock)).toBeDefined());
    const body = putBody(fetchMock);
    expect(body.licenseClass).toBe('EXTRA');
    expect(body.fieldSources).toEqual({
      state: { source: 'callook.info', fetchedAt: '2026-08-04T12:00:00.000Z', value: 'MI' },
    });
  });

  /**
   * A SUPERSEDED CALLSIGN IS A VALUE THE SOURCE SUPPLIED, AND IS STORED AS ONE.
   *
   * The panel refuses to hand it over until the applicant confirms it (proved in
   * `CallsignLookup.test.tsx`). What this proves is the other half: once confirmed, the callsign in
   * the field is marked as read rather than stated, so a reload still says where it came from.
   */
  it('marks a callsign the lookup substituted, and stores the mark', async () => {
    const fetchMock = stubFetch({
      lookup: { status: 'found', record: { ...PERSON_RECORD, callsign: 'W5NEW' } },
    });
    await renderLoaded();
    await userEvent.clear(screen.getByLabelText(/^callsign$/i));
    await userEvent.type(screen.getByLabelText(/^callsign$/i), 'K9OLD');
    await userEvent.click(screen.getByRole('button', { name: /look up this callsign/i }));

    // The panel names both callsigns, so the difference is on screen before anything moves.
    // Matched on a sentence only the panel carries: the live region announces the substitution
    // too, which is the point of C3 and would make a looser query ambiguous.
    const notice = await screen.findByText(/GrantSpotter cannot tell those apart/i);
    expect(notice).toHaveTextContent('K9OLD');
    expect(notice).toHaveTextContent('W5NEW');
    await userEvent.click(screen.getByLabelText(/this record is mine/i));
    await userEvent.click(screen.getByRole('button', { name: /use these values/i }));

    expect(screen.getByLabelText(/^callsign$/i)).toHaveValue('W5NEW');
    expect(screen.getByLabelText(/^callsign$/i).getAttribute('aria-describedby')).toContain(
      'field-callsign-lookup',
    );

    await userEvent.click(screen.getByRole('button', { name: /save student profile/i }));
    await waitFor(() => expect(putCall(fetchMock)).toBeDefined());
    expect(putBody(fetchMock).fieldSources).toMatchObject({
      callsign: { source: 'callook.info', fetchedAt: '2026-08-04T12:00:00.000Z', value: 'W5NEW' },
    });
  });

  /**
   * A MARKER IS A FACT ABOUT ONE LICENSEE, AND THE CALLSIGN IS WHO THAT IS.
   *
   * `ProfileFieldSource` carries the source, the day and the value, and no way of saying who the
   * value is about — so a marker written for W8UM went on reading as "read from callook.info" after
   * the applicant typed K5UTD over the callsign. Every claim on the profile was then about a
   * different licensee than the profile was: callook.info never said anything about K5UTD, and the
   * matcher reads `state` and `licenseClass`.
   *
   * The VALUES stay. They are on screen, they are the applicant's to keep or clear, and a form that
   * empties fields as somebody types in another one is its own defect. What comes off is the
   * source's name on them.
   */
  it('takes the source’s name off every field when the callsign moves to another licensee', async () => {
    const fetchMock = stubFetch({ lookup: { status: 'found', record: PERSON_RECORD } });
    await renderLoaded();
    await lookUpAndAccept();
    expect(screen.getAllByText(/not a value you stated/i)).toHaveLength(2);

    await userEvent.clear(screen.getByLabelText(/^callsign$/i));
    await userEvent.type(screen.getByLabelText(/^callsign$/i), 'K5UTD');

    expect(screen.getByLabelText(/^state$/i)).toHaveValue('MI');
    expect(screen.getByLabelText(/license class/i)).toHaveValue('GENERAL');
    expect(screen.queryAllByText(/not a value you stated/i)).toHaveLength(0);
    expect(screen.queryByText(/marked fields below were read from/i)).not.toBeInTheDocument();

    // And no attribution reaches storage either: `pruneFieldSources` keeps a marker whose VALUE
    // still matches, which every one of these does — it is the subject that moved, not the value.
    await userEvent.click(screen.getByRole('button', { name: /save student profile/i }));
    await waitFor(() => expect(putCall(fetchMock)).toBeDefined());
    const body = putBody(fetchMock);
    expect(body).toMatchObject({ callsign: 'K5UTD', state: 'MI', licenseClass: 'GENERAL' });
    expect(body).not.toHaveProperty('fieldSources');
  });

  /**
   * The marks are compared against the callsign, not deleted by the keystroke that changed it —
   * the same device as the marker's own stored value one level down. So a callsign typed back is
   * the same licence again, and callook.info did state these values for it.
   */
  it('gives the marks back when the callsign comes back, because the record did state them', async () => {
    stubFetch({ lookup: { status: 'found', record: PERSON_RECORD } });
    await renderLoaded();
    await lookUpAndAccept();

    await userEvent.clear(screen.getByLabelText(/^callsign$/i));
    await userEvent.type(screen.getByLabelText(/^callsign$/i), 'K5UTD');
    expect(screen.queryAllByText(/not a value you stated/i)).toHaveLength(0);

    await userEvent.clear(screen.getByLabelText(/^callsign$/i));
    // Lower case on purpose: a callsign is one licence however it is capitalised, and dropping a
    // tab's marks over the shift key would be a badge vanishing for no reason the user can see.
    await userEvent.type(screen.getByLabelText(/^callsign$/i), 'w8um');
    expect(screen.getAllByText(/not a value you stated/i)).toHaveLength(2);
  });

  /**
   * ACCEPTING A RECORD MEANS THAT RECORD IS WHAT THIS PROFILE READ — INCLUDING WHERE IT SAYS
   * NOTHING.
   *
   * Accepting used to merge the new record's markers into the ones already held, so a second
   * record silent on a field left the first licensee's `MI` and `GENERAL` in the form, still
   * marked as read from callook.info. Dropping the mark alone would fix the attribution and leave
   * the worse half: the state the matcher reads would still be the other licensee's, now
   * indistinguishable from something this applicant typed.
   */
  it('does not leave the first licensee’s answers behind when the next record is silent on them', async () => {
    const fetchMock = stubFetch({
      lookups: [
        { status: 'found', record: PERSON_RECORD },
        { status: 'found', record: SILENT_RECORD },
      ],
    });
    await renderLoaded();
    await lookUpAndAccept();
    expect(screen.getByLabelText(/^state$/i)).toHaveValue('MI');
    expect(screen.getByLabelText(/license class/i)).toHaveValue('GENERAL');

    await lookUpAndAccept();

    expect(screen.getByLabelText(/^state$/i)).toHaveValue('');
    expect(screen.getByLabelText(/license class/i)).toHaveValue('');
    expect(screen.queryAllByText(/not a value you stated/i)).toHaveLength(0);
    // ...and the applicant is told, in the live region this form already keeps mounted: a value
    // vanishing from a field is a change they are owed a sentence about.
    expect(screen.getByRole('status')).toHaveTextContent(
      /does not state State and License class, so those fields are now empty/i,
    );

    await userEvent.click(screen.getByRole('button', { name: /save student profile/i }));
    await waitFor(() => expect(putCall(fetchMock)).toBeDefined());
    const body = putBody(fetchMock);
    expect(body).not.toHaveProperty('state');
    expect(body).not.toHaveProperty('licenseClass');
    expect(body).not.toHaveProperty('fieldSources');
  });

  /**
   * The other half of that rule, and the reason it is scoped by the marker rather than by the
   * field: what a lookup clears is the previous RECORD's answer. A value the applicant typed is
   * their own assertion — the strongest thing this tool holds — and an unrelated lookup must not
   * be able to delete one.
   */
  it('clears only what an earlier record put there, never what the applicant typed', async () => {
    stubFetch({
      lookups: [
        { status: 'found', record: PERSON_RECORD },
        { status: 'found', record: SILENT_RECORD },
      ],
    });
    await renderLoaded();
    await lookUpAndAccept();

    await userEvent.clear(screen.getByLabelText(/^state$/i));
    await userEvent.type(screen.getByLabelText(/^state$/i), 'OH');

    await lookUpAndAccept();

    expect(screen.getByLabelText(/^state$/i)).toHaveValue('OH');
    // The licence class was still the first record's, so it goes.
    expect(screen.getByLabelText(/license class/i)).toHaveValue('');
  });

  it('has no accessibility violations with the record on screen', async () => {
    stubFetch({ lookup: { status: 'found', record: PERSON_RECORD } });
    const { container } = await renderLoaded();
    await userEvent.click(screen.getByRole('button', { name: /look up this callsign/i }));
    await screen.findByRole('button', { name: /use these values/i });
    expect(auditA11y(container)).toEqual([]);
  });
});

/**
 * EVERY DERIVED VALUE IS VISIBLY DERIVED — the three cases, and what happens to each of them when
 * the field underneath moves.
 *
 * The editor holds three kinds of value it did not get from the applicant, and until 2026-08-11 it
 * could describe only one of them. A marked value says who stated it and self-invalidates on an
 * edit. A COORDINATE is stated by the record and cannot be marked at all, because core's
 * `StudentFieldSources` has no key for one and the server strips what it does not declare. A CALL
 * DISTRICT is stated by nobody: it is the digit in the callsign, and core's own comment refuses to
 * credit callook.info for arithmetic this tool did itself.
 */
describe('the values nobody typed: a coordinate, and a call district', () => {
  const STREET_RECORD: CallsignRecord = {
    ...PERSON_RECORD,
    mailingGeocode: {
      geocodedFrom: 'street_address',
      mailingAddress: { latitude: 42.2808, longitude: -83.743, gridsquare: 'EN82dg' },
    },
  };

  /** A collegiate club at a PO box: the record two of the three real captures are. */
  const PO_BOX_RECORD: CallsignRecord = {
    ...PERSON_RECORD,
    isPoBox: true,
    addressLine1: 'P.O. BOX 8550',
    mailingGeocode: {
      geocodedFrom: 'po_box',
      poBox: { latitude: 42.34991837, longitude: -71.0538559, gridsquare: 'FN42li' },
    },
  };

  async function lookUpAndAccept(): Promise<void> {
    await userEvent.click(screen.getByRole('button', { name: /look up this callsign/i }));
    await userEvent.click(await screen.findByRole('button', { name: /use these values/i }));
  }

  it('fills the coordinate from a street address, and says it can never mark it', async () => {
    const fetchMock = stubFetch({ lookup: { status: 'found', record: STREET_RECORD } });
    await renderLoaded();
    await lookUpAndAccept();

    expect(screen.getByLabelText(/^latitude$/i)).toHaveValue(42.2808);
    expect(screen.getByLabelText(/^longitude$/i)).toHaveValue(-83.743);
    // Named as fetched WHILE THIS SESSION LASTS, and honest about what happens after it. One per
    // coordinate: the latitude and the longitude are two fields and each explains itself.
    const notes = screen.getAllByText(/carrying no mark, because GrantSpotter cannot record/i);
    expect(notes).toHaveLength(2);
    const note = notes[0] as HTMLElement;
    expect(note).toHaveTextContent('callook.info');
    expect(note).toHaveTextContent('2026-08-04');
    expect(note).toHaveTextContent(/reads exactly like a value you stated/i);

    // The value is saved as a number like any other, and NO marker is sent for it: one would be
    // stripped by the server, and a badge that vanishes on reload is worse than no badge at all.
    await userEvent.click(screen.getByRole('button', { name: /save student profile/i }));
    await waitFor(() => expect(putCall(fetchMock)).toBeDefined());
    const body = putBody(fetchMock);
    expect(body.lat).toBe(42.2808);
    expect(body.lon).toBe(-83.743);
    expect((body.fieldSources as Record<string, unknown>) ?? {}).not.toHaveProperty('lat');
  });

  it('leaves the boxes empty for a PO box, and explains that rather than going quiet', async () => {
    stubFetch({ lookup: { status: 'found', record: PO_BOX_RECORD } });
    await renderLoaded();
    await lookUpAndAccept();

    expect(screen.getByLabelText(/^latitude$/i)).toHaveValue(null);
    expect(screen.getByLabelText(/^longitude$/i)).toHaveValue(null);
    // The standing caveat from the registry, which says why an empty box is an empty box.
    expect(screen.getAllByText(/only from a street address/i).length).toBeGreaterThan(0);
  });

  it('derives the call district from the callsign and says who worked it out', async () => {
    stubFetch({ lookup: { status: 'found', record: PERSON_RECORD } });
    await renderLoaded();
    await lookUpAndAccept();

    expect(screen.getByLabelText(/call district/i)).toHaveValue('8');
    const note = screen.getByText(/works this out from the callsign above/i);
    expect(note).toHaveTextContent(/no source is credited for arithmetic/i);
    // Not attributed to callook.info, which stated no district and does not have one to state.
    expect(note.textContent ?? '').not.toContain('callook.info');
  });

  it('derives it from a callsign nobody looked up, because it is arithmetic and not a lookup', async () => {
    await renderLoaded();
    await userEvent.clear(screen.getByLabelText(/callsign/i));
    await userEvent.type(screen.getByLabelText(/callsign/i), 'K5UTD');
    expect(screen.getByLabelText(/call district/i)).toHaveValue('5');
  });

  /**
   * THE DEFECT THE `derived` CASE EXISTS TO CLOSE, stated as a test. A district left behind after
   * the callsign changes is a fact about a licence this applicant no longer holds, and the matcher
   * reads `callDistrict` straight into a `call_district` verdict — the same class of failure as a
   * provenance marker outliving its callsign, which this component already carries `readFor` for.
   */
  it('follows the callsign when it changes, and empties when the callsign is cleared', async () => {
    await renderLoaded();
    await userEvent.clear(screen.getByLabelText(/callsign/i));
    await userEvent.type(screen.getByLabelText(/callsign/i), 'W8UM');
    expect(screen.getByLabelText(/call district/i)).toHaveValue('8');

    await userEvent.clear(screen.getByLabelText(/callsign/i));
    await userEvent.type(screen.getByLabelText(/callsign/i), 'K5UTD');
    expect(screen.getByLabelText(/call district/i)).toHaveValue('5');

    await userEvent.clear(screen.getByLabelText(/callsign/i));
    expect(screen.getByLabelText(/call district/i)).toHaveValue('');

    // A callsign the FCC did not issue has no US call district: VE3ABC's 3 is Canadian, and
    // `callDistrictFromCallsign` refuses it rather than reporting a district that does not apply.
    await userEvent.type(screen.getByLabelText(/callsign/i), 'VE3ABC');
    expect(screen.getByLabelText(/call district/i)).toHaveValue('');
  });

  it('never overwrites a district the applicant typed themselves', async () => {
    await renderLoaded();
    await userEvent.clear(screen.getByLabelText(/callsign/i));
    await userEvent.type(screen.getByLabelText(/callsign/i), 'W8UM');
    await userEvent.clear(screen.getByLabelText(/call district/i));
    await userEvent.type(screen.getByLabelText(/call district/i), '9');

    await userEvent.clear(screen.getByLabelText(/callsign/i));
    await userEvent.type(screen.getByLabelText(/callsign/i), 'K5UTD');

    // Theirs, and it stays theirs — and it stops describing itself as derived, because it is not.
    expect(screen.getByLabelText(/call district/i)).toHaveValue('9');
    expect(screen.queryByText(/works this out from the callsign above/i)).not.toBeInTheDocument();
  });

  /**
   * The coordinate half of "a marker that outlives its callsign describes somebody else". There is
   * no marker to go inert here, so the component holds the value the lookup wrote and compares
   * against it — the same arithmetic, one level up.
   */
  it('does not leave one licensee’s coordinate behind for the next', async () => {
    stubFetch({
      lookups: [
        { status: 'found', record: STREET_RECORD },
        { status: 'found', record: SILENT_RECORD },
      ],
    });
    await renderLoaded();
    await lookUpAndAccept();
    expect(screen.getByLabelText(/^latitude$/i)).toHaveValue(42.2808);

    await lookUpAndAccept();
    expect(screen.getByLabelText(/^latitude$/i)).toHaveValue(null);
    expect(screen.getByRole('status')).toHaveTextContent(/Latitude/);
  });

  /**
   * PRESSING SAVE MUST NOT LAUNDER A FETCHED COORDINATE INTO AN UNACCOUNTABLE ONE.
   *
   * The PUT reply is the profile as STORED, and the stored profile has nowhere to say a coordinate
   * was fetched — so reading the component's state back from that echo silently forgets it, and
   * the next lookup then has nothing to compare against and leaves the previous licensee's
   * coordinate in the form. Measured in a real browser before the fix: accept W1AW's street
   * coordinate, save, then accept W1MX's record, and Latitude still read 41.714707 — Newington,
   * Connecticut, on a profile that now said MA.
   */
  it('still knows where a coordinate came from after the profile is saved', async () => {
    stubFetch({
      lookups: [
        { status: 'found', record: STREET_RECORD },
        { status: 'found', record: SILENT_RECORD },
      ],
    });
    await renderLoaded();
    await lookUpAndAccept();
    await userEvent.click(screen.getByRole('button', { name: /save student profile/i }));
    await screen.findByText(/profile saved/i);
    expect(screen.getAllByText(/carrying no mark, because GrantSpotter cannot record/i))
      .toHaveLength(2);

    await lookUpAndAccept();
    expect(screen.getByLabelText(/^latitude$/i)).toHaveValue(null);
  });

  it('keeps a coordinate the applicant typed over, because that one is theirs', async () => {
    stubFetch({
      lookups: [
        { status: 'found', record: STREET_RECORD },
        { status: 'found', record: SILENT_RECORD },
      ],
    });
    await renderLoaded();
    await lookUpAndAccept();

    await userEvent.clear(screen.getByLabelText(/^latitude$/i));
    await userEvent.type(screen.getByLabelText(/^latitude$/i), '40');

    await lookUpAndAccept();
    expect(screen.getByLabelText(/^latitude$/i)).toHaveValue(40);
  });

  it('stops claiming a coordinate was read for this applicant once the callsign is somebody else’s', async () => {
    stubFetch({ lookup: { status: 'found', record: STREET_RECORD } });
    await renderLoaded();
    await lookUpAndAccept();
    expect(screen.getAllByText(/carrying no mark, because GrantSpotter cannot record/i))
      .toHaveLength(2);

    await userEvent.clear(screen.getByLabelText(/callsign/i));
    await userEvent.type(screen.getByLabelText(/callsign/i), 'K5UTD');

    // The number stays — it is on screen and the applicant may have meant to keep it — and the
    // claim about whose record it came from does not, exactly as a marker's does not.
    expect(screen.getByLabelText(/^latitude$/i)).toHaveValue(42.2808);
    expect(screen.queryAllByText(/carrying no mark, because GrantSpotter cannot record/i))
      .toHaveLength(0);
  });
});

/**
 * WHICH BOXES CHANGE THE ANSWER. Thirty-five inputs with nothing to tell them apart invites
 * somebody to treat "Member count" and "GPA" as equally load-bearing and give up in the middle.
 */
describe('saying which fields the matcher reads', () => {
  it('marks a field a verdict can depend on, and one it cannot, in words', async () => {
    await renderLoaded();
    expect(screen.getByLabelText(/gpa/i).getAttribute('aria-describedby')).toContain(
      'field-gpa-matcher',
    );
    expect(document.getElementById('field-gpa-matcher')?.textContent).toMatch(
      /can change your verdicts/i,
    );
    expect(document.getElementById('field-institution-matcher')?.textContent).toMatch(
      /never reads this to decide a verdict/i,
    );
  });

  it('says an empty field leaves a rule unanswered rather than answered against you', async () => {
    await renderLoaded();
    expect(screen.getByText(/leaving a field empty leaves the rules that need it/i))
      .toBeInTheDocument();
  });

  it('tells an organisation which of its own boxes are decorative', async () => {
    await renderLoaded();
    await userEvent.click(screen.getByRole('tab', { name: /organization/i }));
    expect(document.getElementById('field-memberCount-matcher')?.textContent).toMatch(
      /never reads this to decide a verdict/i,
    );
    expect(document.getElementById('field-lat-matcher')?.textContent).toMatch(
      /can change your verdicts/i,
    );
  });
});
