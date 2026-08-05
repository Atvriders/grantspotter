import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { EnrollmentCode } from '@grantspotter/core';
import { EnrollmentCodes, enrollmentCodeState } from './EnrollmentCodes.js';

const NOW = '2026-08-04T12:00:00.000Z';

function makeCode(overrides: Partial<EnrollmentCode> = {}): EnrollmentCode {
  return {
    id: 'code-1',
    label: 'W1MX autumn 2026 intake',
    maxUses: 5,
    uses: 2,
    expiresAt: '2026-12-31T00:00:00.000Z',
    revokedAt: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    createdByUserId: 'u-admin',
    lastUsedAt: '2026-08-03T00:00:00.000Z',
    ...overrides,
  };
}

const ACTIVE = makeCode();
const REVOKED = makeCode({
  id: 'code-2',
  label: 'Field Day visitors',
  revokedAt: '2026-08-02T00:00:00.000Z',
});

const CREATED_PLAINTEXT = 'ENR-7fq2-kv91-tt40';

type Override = (url: string, init?: RequestInit) => unknown;

/**
 * A permissive fake API, in the shape `routes/Admin.test.tsx` uses: `overrides` answers the one
 * call a test is about, and everything else gets a body the section can render.
 */
function stubFetch(overrides: Override = () => undefined, codes: EnrollmentCode[] = [ACTIVE]) {
  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const custom = overrides(url, init);
    if (custom !== undefined) return Promise.resolve(custom);
    if (init?.method === 'POST' && url === '/api/admin/enrollment-codes') {
      return Promise.resolve({
        ok: true,
        status: 201,
        json: async () => ({
          code: makeCode({ id: 'code-new', label: 'New intake', uses: 0, lastUsedAt: null }),
          plaintext: CREATED_PLAINTEXT,
        }),
      });
    }
    if (init?.method === 'POST' && url.endsWith('/revoke')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ code: { ...ACTIVE, revokedAt: NOW } }),
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ codes }) });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function forbidden(message: string) {
  return {
    ok: false,
    status: 403,
    json: async () => ({ error: { code: 'forbidden', message }, requestId: 'req-test-1' }),
  };
}

function renderSection() {
  return render(<EnrollmentCodes now={NOW} />);
}

async function createCode(label = 'W1MX autumn 2026 intake'): Promise<void> {
  await userEvent.type(await screen.findByLabelText(/what this code is for/i), label);
  await userEvent.click(screen.getByRole('button', { name: /create enrollment code/i }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the state a code is in', () => {
  it('calls a code with uses left, a future expiry and no revocation active', () => {
    expect(enrollmentCodeState(ACTIVE, NOW)).toBe('active');
  });

  it('reports revocation over expiry and exhaustion, because somebody decided it', () => {
    const everything = makeCode({
      revokedAt: '2026-08-02T00:00:00.000Z',
      expiresAt: '2026-08-03T00:00:00.000Z',
      uses: 9,
      maxUses: 5,
    });
    expect(enrollmentCodeState(everything, NOW)).toBe('revoked');
  });

  it('reports an expiry that has passed', () => {
    expect(enrollmentCodeState(makeCode({ expiresAt: '2026-08-03T00:00:00.000Z' }), NOW)).toBe(
      'expired',
    );
  });

  it('reports a code that has reached its limit', () => {
    expect(enrollmentCodeState(makeCode({ uses: 5, maxUses: 5 }), NOW)).toBe('used-up');
  });

  it('never calls a limitless code used up, however many times it has been used', () => {
    expect(enrollmentCodeState(makeCode({ uses: 400, maxUses: null }), NOW)).toBe('active');
  });

  it('treats an unreadable expiry as no expiry rather than guessing it has passed', () => {
    expect(enrollmentCodeState(makeCode({ expiresAt: 'not-a-date' }), NOW)).toBe('active');
  });
});

describe('the enrollment code list', () => {
  it('shows each code with what it is for, its uses against its limit, and its expiry', async () => {
    stubFetch();
    renderSection();
    const table = await screen.findByRole('table', { name: /enrollment codes/i });
    const row = within(table).getByText('W1MX autumn 2026 intake').closest('tr') as HTMLElement;
    expect(within(row).getByText('2 of 5')).toBeInTheDocument();
    expect(within(row).getByText('2026-12-31')).toBeInTheDocument();
    expect(within(row).getByText('Active')).toBeInTheDocument();
  });

  it('says "no limit" rather than rendering a null as a number', async () => {
    stubFetch(() => undefined, [makeCode({ maxUses: null, uses: 12 })]);
    renderSection();
    const table = await screen.findByRole('table', { name: /enrollment codes/i });
    expect(within(table).getByText('12 (no limit)')).toBeInTheDocument();
    expect(within(table).queryByText(/null/i)).not.toBeInTheDocument();
  });

  it('says "no expiry" rather than leaving the cell blank', async () => {
    stubFetch(() => undefined, [makeCode({ expiresAt: null })]);
    renderSection();
    const table = await screen.findByRole('table', { name: /enrollment codes/i });
    expect(within(table).getByText('No expiry')).toBeInTheDocument();
  });

  it('marks a revoked code, dates the revocation and offers nothing more to revoke', async () => {
    stubFetch(() => undefined, [REVOKED]);
    renderSection();
    const table = await screen.findByRole('table', { name: /enrollment codes/i });
    const row = within(table).getByText('Field Day visitors').closest('tr') as HTMLElement;
    expect(within(row).getByText('Revoked')).toBeInTheDocument();
    expect(within(row).getByText(/revoked 2026-08-02/i)).toBeInTheDocument();
    expect(
      within(row).queryByRole('button', { name: /revoke field day visitors/i }),
    ).not.toBeInTheDocument();
  });

  it('says an instance has no codes instead of showing an empty table', async () => {
    stubFetch(() => undefined, []);
    renderSection();
    expect(await screen.findByText(/no enrollment codes yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: /enrollment codes/i })).not.toBeInTheDocument();
  });

  it('reports a list that could not be loaded instead of showing an empty one', async () => {
    stubFetch((url, init) =>
      init?.method === 'GET' && url === '/api/admin/enrollment-codes'
        ? forbidden('Admin role required.')
        : undefined,
    );
    renderSection();
    expect(await screen.findByRole('alert')).toHaveTextContent(/admin role required/i);
  });
});

describe('creating a code', () => {
  it('sends the label with explicit nulls for "no limit" and "no expiry"', async () => {
    const fetchMock = stubFetch();
    renderSection();
    await createCode('Field Day visitors');

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        (c) => (c[1] as RequestInit | undefined)?.method === 'POST',
      );
      expect(JSON.parse((post?.[1] as RequestInit).body as string)).toEqual({
        label: 'Field Day visitors',
        maxUses: null,
        expiresInDays: null,
      });
    });
  });

  it('sends the limit and the expiry when they are given', async () => {
    const fetchMock = stubFetch();
    renderSection();
    await userEvent.type(await screen.findByLabelText(/what this code is for/i), 'One student');
    await userEvent.type(screen.getByLabelText(/maximum uses/i), '1');
    await userEvent.type(screen.getByLabelText(/expires in days/i), '30');
    await userEvent.click(screen.getByRole('button', { name: /create enrollment code/i }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        (c) => (c[1] as RequestInit | undefined)?.method === 'POST',
      );
      expect(JSON.parse((post?.[1] as RequestInit).body as string)).toEqual({
        label: 'One student',
        maxUses: 1,
        expiresInDays: 30,
      });
    });
  });

  it('shows the code exactly once, says so, and offers a way to copy it', async () => {
    const user = userEvent.setup();
    stubFetch();
    renderSection();
    await createCode();

    const banner = await screen.findByRole('status');
    expect(banner).toHaveTextContent(CREATED_PLAINTEXT);
    expect(banner).toHaveTextContent(/shown once/i);
    expect(banner).toHaveTextContent(/can never show it again/i);

    await user.click(within(banner).getByRole('button', { name: /copy the enrollment code/i }));
    await expect(navigator.clipboard.readText()).resolves.toBe(CREATED_PLAINTEXT);
    expect(await screen.findByText(/copied to the clipboard/i)).toBeInTheDocument();
  });

  it('never puts the code in a request URL', async () => {
    const fetchMock = stubFetch();
    renderSection();
    await createCode();
    await screen.findByRole('status');
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).not.toContain(CREATED_PLAINTEXT);
    }
  });

  /**
   * "Shown once" has to mean once. The reload that follows creation re-reads the list, and the
   * list carries no plaintext — so the moment anything else happens on this screen, the only copy
   * of the code is the one the admin took.
   */
  it('cannot show the code again after the next action', async () => {
    stubFetch();
    renderSection();
    await createCode();
    await screen.findByRole('status');

    await userEvent.click(
      await screen.findByRole('button', { name: /revoke w1mx autumn 2026 intake/i }),
    );

    await waitFor(() => {
      expect(screen.queryByText(CREATED_PLAINTEXT)).not.toBeInTheDocument();
    });
    // And nothing on the screen offers to bring it back.
    expect(screen.queryByRole('button', { name: /show|reveal/i })).not.toBeInTheDocument();
  });

  it('asks what the code is for instead of creating an unlabelled one', async () => {
    const fetchMock = stubFetch();
    renderSection();
    await screen.findByRole('table', { name: /enrollment codes/i });
    await userEvent.click(screen.getByRole('button', { name: /create enrollment code/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/say what this code is for/i);
    expect(
      fetchMock.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === 'POST'),
    ).toBe(false);
  });

  it('refuses a maximum of zero rather than sending a code nobody can use', async () => {
    const fetchMock = stubFetch();
    renderSection();
    await userEvent.type(await screen.findByLabelText(/what this code is for/i), 'Zero uses');
    await userEvent.type(screen.getByLabelText(/maximum uses/i), '0');
    await userEvent.click(screen.getByRole('button', { name: /create enrollment code/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/whole number of 1 or more/i);
    expect(
      fetchMock.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === 'POST'),
    ).toBe(false);
  });

  it('surfaces the server’s refusal rather than appearing to succeed', async () => {
    stubFetch((url, init) =>
      init?.method === 'POST' && url === '/api/admin/enrollment-codes'
        ? forbidden('Only an admin can issue enrollment codes.')
        : undefined,
    );
    renderSection();
    await createCode();
    expect(await screen.findByRole('alert')).toHaveTextContent(/only an admin can issue/i);
    expect(screen.queryByText(CREATED_PLAINTEXT)).not.toBeInTheDocument();
  });
});

describe('revoking a code', () => {
  it('posts to the revoke route and says what that does and does not undo', async () => {
    const fetchMock = stubFetch();
    renderSection();
    await userEvent.click(
      await screen.findByRole('button', { name: /revoke w1mx autumn 2026 intake/i }),
    );

    await waitFor(() => {
      const post = fetchMock.mock.calls.find((c) =>
        String(c[0]).endsWith('/api/admin/enrollment-codes/code-1/revoke'),
      );
      expect(post).toBeDefined();
    });

    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent(/can no longer create an account/i);
    // Revoking a code is not a way to remove the people who already used it.
    expect(notice).toHaveTextContent(/accounts it already created are untouched/i);
  });

  it('re-reads the list afterwards, so a row cannot keep a state the server never took', async () => {
    const fetchMock = stubFetch();
    renderSection();
    await screen.findByRole('table', { name: /enrollment codes/i });
    const readsBefore = fetchMock.mock.calls.filter(
      (c) => (c[1] as RequestInit | undefined)?.method === 'GET',
    ).length;

    await userEvent.click(screen.getByRole('button', { name: /revoke w1mx autumn 2026 intake/i }));

    await waitFor(() => {
      const readsAfter = fetchMock.mock.calls.filter(
        (c) => (c[1] as RequestInit | undefined)?.method === 'GET',
      ).length;
      expect(readsAfter).toBeGreaterThan(readsBefore);
    });
  });

  it('reports a refused revoke instead of showing it as done', async () => {
    stubFetch((url, init) =>
      init?.method === 'POST' && url.endsWith('/revoke')
        ? forbidden('That code belongs to another instance.')
        : undefined,
    );
    renderSection();
    await userEvent.click(
      await screen.findByRole('button', { name: /revoke w1mx autumn 2026 intake/i }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(/another instance/i);
  });
});

describe('what the section says before anything is clicked', () => {
  it('states that enrolment can never grant admin', async () => {
    stubFetch();
    renderSection();
    expect(await screen.findByText(/cannot grant admin/i)).toBeInTheDocument();
  });

  it('states that a lost code is replaced, not recovered', async () => {
    stubFetch();
    renderSection();
    expect(await screen.findByText(/replaced, not recovered/i)).toBeInTheDocument();
  });

  it('labels every control it renders', async () => {
    stubFetch();
    const { container } = renderSection();
    await screen.findByRole('table', { name: /enrollment codes/i });
    for (const control of container.querySelectorAll('input, button')) {
      const named =
        (control.getAttribute('aria-label') ?? '').trim() !== '' ||
        (control.textContent ?? '').trim() !== '' ||
        Array.from((control as HTMLInputElement).labels ?? []).length > 0;
      expect(named).toBe(true);
    }
  });
});
