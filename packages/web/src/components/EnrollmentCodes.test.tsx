import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { EnrollmentCode } from '@grantspotter/core';
import { CHOSEN_CODE_MIN_LENGTH } from '@grantspotter/core';
import { confusableTwin, EnrollmentCodes, enrollmentCodeState } from './EnrollmentCodes.js';

const NOW = '2026-08-04T12:00:00.000Z';

function makeCode(overrides: Partial<EnrollmentCode> = {}): EnrollmentCode {
  return {
    id: 'code-1',
    label: 'W1MX autumn 2026 intake',
    chosen: false,
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
          // The server's reading of the plaintext. `ENR-7fq2-kv91-tt40` folds its `l` onto `1`.
          normalized: 'ENR7FQ2KV91TT40',
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
        // An empty code box means "generate one", sent as an explicit null rather than left off.
        code: null,
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
        code: null,
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

/**
 * THE CODE AN ADMINISTRATOR TYPES, AND THE ONE THING THE CONSOLE MUST NOT LET THEM MISS.
 *
 * A chosen code is not the string they typed. `W1MX-FALL-2026` is stored as `W1MXFA112026`, and
 * `WIMX-FA11-2O26` is the same code — which is what makes two different-looking chosen codes able
 * to collide, and what makes "show them their own typing back" a lie. Everything below is about
 * the console showing the stored form at the moment of the decision rather than afterwards.
 */
describe('choosing the code instead of generating one', () => {
  async function typeCode(value: string): Promise<HTMLElement> {
    await userEvent.type(await screen.findByLabelText(/^code \(blank to generate one\)/i), value);
    return screen.getByLabelText(/^code \(blank to generate one\)/i);
  }

  it('offers to generate one, and says what typing your own costs, before anything is typed', async () => {
    stubFetch();
    renderSection();
    const box = await screen.findByLabelText(/^code \(blank to generate one\)/i);
    const note = document.getElementById(box.getAttribute('aria-describedby') ?? '');

    expect(note).not.toBeNull();
    expect(note).toHaveTextContent(/blank generates twenty random characters/i);
    // The trade, in the sentence a person reads rather than in a document.
    expect(note).toHaveTextContent(/a code somebody can remember is a code somebody can guess/i);
    expect(note).toHaveTextContent(new RegExp(`at least ${String(CHOSEN_CODE_MIN_LENGTH)}`, 'i'));
  });

  it('shows the normalised form, not the typing, while the administrator types', async () => {
    stubFetch();
    renderSection();
    const box = await typeCode('W1MX-FALL-2026');
    const note = document.getElementById(box.getAttribute('aria-describedby') ?? '');

    // What they typed has dashes and an L. What is stored has neither.
    expect(note).toHaveTextContent('W1MXFA112026');
    expect(note).toHaveTextContent(/12 characters/);
    // And the fold is named, with a second spelling of THEIR code rather than an abstract example.
    expect(note).toHaveTextContent(/O counts as 0/);
    expect(note).toHaveTextContent(confusableTwin('W1MXFA112026'));
  });

  it('says the floor and the count when the code is too short, before the press', async () => {
    stubFetch();
    renderSection();
    const box = await typeCode('W1MX2026');
    const note = document.getElementById(box.getAttribute('aria-describedby') ?? '');

    expect(note).toHaveTextContent('W1MX2026');
    expect(note).toHaveTextContent(/8 characters/);
    expect(note).toHaveTextContent(
      new RegExp(`a code you choose needs at least ${String(CHOSEN_CODE_MIN_LENGTH)}`, 'i'),
    );
  });

  it('stops calling the expiry optional once a code has been typed', async () => {
    stubFetch();
    renderSection();
    expect(await screen.findByLabelText(/blank for no expiry/i)).toBeInTheDocument();

    await typeCode('W1MX-FALL-2026');
    expect(screen.queryByLabelText(/blank for no expiry/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/required for a code you choose/i)).toBeInTheDocument();
  });

  it('sends the code exactly as typed, so the fold happens once and on the server', async () => {
    const fetchMock = stubFetch();
    renderSection();
    await userEvent.type(await screen.findByLabelText(/what this code is for/i), 'Autumn intake');
    await typeCode('W1MX-FALL-2026');
    await userEvent.type(screen.getByLabelText(/expires in days/i), '90');
    await userEvent.click(screen.getByRole('button', { name: /create enrollment code/i }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        (c) => (c[1] as RequestInit | undefined)?.method === 'POST',
      );
      expect(JSON.parse((post?.[1] as RequestInit).body as string)).toEqual({
        label: 'Autumn intake',
        code: 'W1MX-FALL-2026',
        maxUses: null,
        expiresInDays: 90,
      });
    });
  });

  it('tells the administrator what a chosen code is worth, on the banner that shows it', async () => {
    stubFetch(
      (url, init) =>
        init?.method === 'POST' && url === '/api/admin/enrollment-codes'
          ? {
              ok: true,
              status: 201,
              json: async () => ({
                code: makeCode({ id: 'code-new', label: 'Autumn intake', chosen: true, uses: 0 }),
                plaintext: 'W1MX-FALL-2026',
                normalized: 'W1MXFA112026',
              }),
            }
          : undefined,
      [],
    );
    renderSection();
    await createCode('Autumn intake');

    const banner = await screen.findByRole('status');
    // Their typing, and then the thing they actually committed to.
    expect(banner).toHaveTextContent('W1MX-FALL-2026');
    expect(banner).toHaveTextContent('W1MXFA112026');
    expect(banner).toHaveTextContent(confusableTwin('W1MXFA112026'));
    // The honest half, said where the decision has just been made rather than in a document.
    expect(banner).toHaveTextContent(/short enough for somebody to think of/i);
    expect(banner).toHaveTextContent(/not safe from being guessed/i);
  });

  it('says none of that about a generated code, because none of it is true of one', async () => {
    stubFetch();
    renderSection();
    await createCode();

    const banner = await screen.findByRole('status');
    expect(banner).toHaveTextContent(CREATED_PLAINTEXT);
    expect(banner).not.toHaveTextContent(/think of/i);
    expect(banner).not.toHaveTextContent(/GrantSpotter stores that as/i);
  });

  it('surfaces the server’s refusal verbatim rather than inventing its own', async () => {
    stubFetch((url, init) =>
      init?.method === 'POST' && url === '/api/admin/enrollment-codes'
        ? {
            ok: false,
            status: 422,
            json: async () => ({
              error: {
                code: 'validation_failed',
                message: 'That code is 8 characters once capitals, dashes and spaces are taken out',
              },
              requestId: 'req-test-2',
            }),
          }
        : undefined,
    );
    renderSection();
    await createCode('Autumn intake');
    // The number is the server's, because the derivation is the server's. A second copy in the
    // browser is a second copy to keep in step.
    expect(await screen.findByRole('alert')).toHaveTextContent(/8 characters once capitals/i);
  });

  it('marks which codes were chosen and which were generated, on every row', async () => {
    stubFetch(() => undefined, [
      makeCode({ id: 'g', label: 'Generated intake', chosen: false }),
      makeCode({ id: 'c', label: 'Chosen intake', chosen: true }),
    ]);
    renderSection();
    const table = await screen.findByRole('table', { name: /enrollment codes/i });

    const generated = within(table).getByText('Generated intake').closest('tr') as HTMLElement;
    const chosen = within(table).getByText('Chosen intake').closest('tr') as HTMLElement;
    expect(within(generated).getByText('Generated')).toBeInTheDocument();
    expect(within(chosen).getByText('Chosen')).toBeInTheDocument();
    // Both words are printed. A reader cannot infer anything from a tag they do not know exists.
    expect(within(generated).queryByText('Chosen')).not.toBeInTheDocument();
  });
});

describe('the second spelling of a chosen code', () => {
  it('writes every folded digit back as a letter that folds onto it', () => {
    expect(confusableTwin('W1MXFA112026')).toBe('WIMXFAII2O26');
  });

  it('leaves a code alone when nothing in it can be spelled another way', () => {
    // No 0 and no 1, so there is no second spelling to warn about.
    expect(confusableTwin('K7QF29XMPT3RJVH8WCND')).toBe('K7QF29XMPT3RJVH8WCND');
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
