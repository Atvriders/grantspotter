import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Profile } from './Profile.js';
import type { CompletenessReport, ProfileKind } from '../store/session.js';

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
 */
function stubFetch(options: { get?: ProfilesBody; putReport?: CompletenessReport } = {}) {
  const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
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
    return Promise.resolve(jsonResponse(options.get ?? PROFILES));
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
