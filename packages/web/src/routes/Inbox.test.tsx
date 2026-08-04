import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { Program } from '@grantspotter/core';
import { Inbox, QUEUE_CAP, describeChangeValue, queueSummary } from './Inbox.js';
import type { InboxRow } from './Inbox.js';

function makeCandidate(over: Partial<Program> = {}): Program {
  return {
    id: 'arrl-foundation-scholarship',
    funderId: 'arrl',
    name: 'ARRL Foundation Scholarship Program',
    klass: 'ham_scholarship',
    summary: 'One application covers the ARRL Foundation scholarship catalog.',
    applicantEntities: ['individual'],
    amount: { instrument: 'cash_range', amountRaw: '$500 - $25,000', awardCountRaw: '170+' },
    deadline: {
      kind: 'annual_window',
      source: { kind: 'self' },
      note: 'Closes Dec 30 at 12:00 PM EST.',
    },
    applyVia: 'page_form',
    applyUrl: 'https://www.arrl.org/scholarship-program',
    constraints: [],
    fundingRestrictions: [],
    obligations: {},
    aiPolicy: { stance: 'unaddressed' },
    trust: {
      status: 'open',
      sourceUrl: 'https://www.arrl.org/scholarship-program',
      lastVerifiedAt: '2026-08-01T00:00:00.000Z',
      verificationMethod: 'live_fetch',
      contentHash: 'c0ffee',
    },
    rawOtherText: '',
    tags: ['tier:A', 'source:arrl-scholarship-descriptions'],
    ...over,
  };
}

function makeRow(over: Partial<InboxRow> = {}): InboxRow {
  return {
    id: 'ri-1',
    decision: 'pending',
    decidedBy: null,
    decidedAt: null,
    confidence: 0.82,
    rejectKey: null,
    candidate: makeCandidate(),
    changeEvent: {
      id: 'ce-1',
      sourceId: 'arrl-scholarship-descriptions',
      programId: 'arrl-foundation-scholarship',
      kind: 'deadline_changed',
      before: 'January 31',
      after: 'December 30, 12:00 PM EST',
      detectedAt: '2026-08-02T03:17:00.000Z',
      fieldPath: 'deadline.note',
    },
    ...over,
  };
}

interface StubOptions {
  rows?: InboxRow[];
  canDecide: boolean;
  /** What the decision POST answers with. Default: an approval that wrote the corpus. */
  post?: { status: number; body: unknown };
}

function stubFetch(options: StubOptions): ReturnType<typeof vi.fn> {
  const rows = options.rows ?? [makeRow()];
  const post = options.post ?? {
    status: 200,
    body: {
      id: 'ri-1',
      decision: 'approved',
      decidedBy: 'u-admin',
      decidedAt: '2026-08-02T12:00:00.000Z',
      published: true,
    },
  };
  const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      return Promise.resolve({
        ok: post.status < 400,
        status: post.status,
        json: () => Promise.resolve(post.body),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ rows, canDecide: options.canDecide }),
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderInbox(): void {
  render(
    <MemoryRouter>
      <Inbox />
    </MemoryRouter>,
  );
}

function postBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = fetchMock.mock.calls.find(
    (c) => (c[1] as RequestInit | undefined)?.method === 'POST',
  );
  if (call === undefined) throw new Error('no POST was made');
  return JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>;
}

function postUrl(fetchMock: ReturnType<typeof vi.fn>): string {
  const call = fetchMock.mock.calls.find(
    (c) => (c[1] as RequestInit | undefined)?.method === 'POST',
  );
  if (call === undefined) throw new Error('no POST was made');
  return String(call[0]);
}

async function findItem(name: RegExp): Promise<HTMLElement> {
  return screen.findByRole('article', { name });
}

describe('Inbox as a member', () => {
  it('shows the pending change with its before and its after', async () => {
    stubFetch({ canDecide: false });
    renderInbox();
    const item = await findItem(/ARRL Foundation Scholarship Program/);
    expect(within(item).getByText('January 31')).toBeInTheDocument();
    expect(within(item).getByText('December 30, 12:00 PM EST')).toBeInTheDocument();
  });

  it('states plainly that the queue is read-only for this account', async () => {
    stubFetch({ canDecide: false });
    renderInbox();
    expect(
      await screen.findByText(/only an administrator can approve or reject/i),
    ).toBeInTheDocument();
  });

  it('tells the member they are watching the queue, not blocked by a fault', async () => {
    stubFetch({ canDecide: false });
    renderInbox();
    const note = await screen.findByRole('note');
    expect(note.textContent).toMatch(/nothing is hidden|nothing here is hidden/i);
    expect(note.textContent).not.toMatch(/permission denied|not allowed|error/i);
  });

  it('renders no decision controls at all, rather than disabled ones', async () => {
    stubFetch({ canDecide: false });
    renderInbox();
    await findItem(/ARRL Foundation Scholarship Program/);
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reject/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
  });

  it('names the source and the detection date so the claim is checkable', async () => {
    stubFetch({ canDecide: false });
    renderInbox();
    const item = await findItem(/ARRL Foundation Scholarship Program/);
    expect(within(item).getByText('arrl-scholarship-descriptions')).toBeInTheDocument();
    expect(within(item).getByText(/2026-08-02/)).toBeInTheDocument();
    expect(within(item).getByText('deadline.note')).toBeInTheDocument();
  });
});

describe('Inbox as an admin', () => {
  it('offers approve, reject and edit', async () => {
    stubFetch({ canDecide: true });
    renderInbox();
    expect(await screen.findByRole('button', { name: /^approve$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^reject$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^edit$/i })).toBeInTheDocument();
  });

  it('posts an approval to the item it was clicked on', async () => {
    const fetchMock = stubFetch({ canDecide: true });
    renderInbox();
    await userEvent.click(await screen.findByRole('button', { name: /^approve$/i }));
    await waitFor(() => {
      expect(postUrl(fetchMock)).toBe('/api/inbox/ri-1/decision');
    });
    expect(postBody(fetchMock).decision).toBe('approved');
  });

  /**
   * The defect Task 12 found, pinned from the client side. A browser-composed
   * `rejectKey` is not the key `buildReviewItems` looks reject memory up under, so
   * sending one suppressed nothing and the candidate came back every night. The
   * server now derives the key with Plan 2's `rejectKeyFor`; this page must not
   * offer it a wrong one to prefer.
   */
  it('sends no client-composed rejectKey with a rejection', async () => {
    const fetchMock = stubFetch({ canDecide: true });
    renderInbox();
    await userEvent.click(await screen.findByRole('button', { name: /^reject$/i }));
    await userEvent.click(await screen.findByRole('button', { name: /confirm rejection/i }));
    await waitFor(() => {
      expect(postBody(fetchMock).decision).toBe('rejected');
    });
    expect(postBody(fetchMock)).not.toHaveProperty('rejectKey');
  });

  it("carries the reviewer's reason into the audit trail", async () => {
    const fetchMock = stubFetch({ canDecide: true });
    renderInbox();
    await userEvent.click(await screen.findByRole('button', { name: /^reject$/i }));
    await userEvent.type(
      screen.getByLabelText(/why/i),
      'The ARRL page still says January 31; the parser read a sidebar.',
    );
    await userEvent.click(screen.getByRole('button', { name: /confirm rejection/i }));
    await waitFor(() => {
      expect(postBody(fetchMock).reason).toBe(
        'The ARRL page still says January 31; the parser read a sidebar.',
      );
    });
  });

  it('lets an admin edit the candidate deadline note before approving', async () => {
    const fetchMock = stubFetch({ canDecide: true });
    renderInbox();
    await userEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    const field = screen.getByLabelText(/deadline note/i);
    await userEvent.clear(field);
    await userEvent.type(field, 'Closes Dec 30, hand-checked.');
    await userEvent.click(screen.getByRole('button', { name: /save and approve/i }));
    await waitFor(() => {
      expect(postBody(fetchMock).decision).toBe('edited');
    });
    const candidate = postBody(fetchMock).candidate as Program;
    expect(candidate.deadline.note).toBe('Closes Dec 30, hand-checked.');
    // The server revalidates the whole Program against `programSchema`, so the
    // edit must be the stored candidate with one field changed, not a fragment.
    expect(candidate.id).toBe('arrl-foundation-scholarship');
    expect(candidate.trust.contentHash).toBe('c0ffee');
  });

  it('shows the parser confidence, because a low score deserves a closer look', async () => {
    stubFetch({ canDecide: true });
    renderInbox();
    expect(await screen.findByText(/0\.82/)).toBeInTheDocument();
    expect(screen.queryByText(/low, read the payload/i)).not.toBeInTheDocument();
  });

  it('says so when the pipeline was guessing', async () => {
    stubFetch({ canDecide: true, rows: [makeRow({ confidence: 0.3 })] });
    renderInbox();
    const item = await findItem(/ARRL Foundation Scholarship Program/);
    expect(item.textContent).toMatch(/low, read the payload/i);
  });

  it('does not post the same decision twice when the button is double-clicked', async () => {
    const fetchMock = stubFetch({ canDecide: true });
    renderInbox();
    const approve = await screen.findByRole('button', { name: /^approve$/i });
    await userEvent.dblClick(approve);
    await waitFor(() => {
      expect(fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST')).toHaveLength(1);
    });
  });

  /**
   * The `do_not_publish` backstop is a deliberate refusal that stands between 37
   * already-funded clubs and a browse list presenting them as open. It arrives as
   * a 409 whose message explains itself — swallowing it leaves the reviewer
   * clicking a button that appears to do nothing.
   */
  it('shows the conflict when the server refuses to publish a suppressed candidate', async () => {
    stubFetch({
      canDecide: true,
      post: {
        status: 409,
        body: {
          error: {
            code: 'conflict',
            message: 'This candidate is tagged do_not_publish: it is a past recipient, not an opportunity.',
          },
          requestId: 'req-1',
        },
      },
    });
    renderInbox();
    await userEvent.click(await screen.findByRole('button', { name: /^approve$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/do_not_publish/);
  });

  it('says the API could not be reached rather than inventing a refusal', async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ rows: [makeRow()], canDecide: true }),
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderInbox();
    await userEvent.click(await screen.findByRole('button', { name: /^approve$/i }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not be reached/i);
    expect(alert.textContent).not.toMatch(/rejected|refused/i);
  });
});

describe('Inbox decision outcomes', () => {
  const vanished = makeRow({
    id: 'ri-vanished',
    decision: 'approved',
    decidedBy: 'admin@example.com',
    decidedAt: '2026-08-02T12:00:00.000Z',
    changeEvent: {
      id: 'ce-2',
      sourceId: 'qcwa-scholarships',
      programId: 'qcwa-scholarship',
      kind: 'vanished',
      before: 'QCWA Scholarship',
      after: null,
      detectedAt: '2026-08-01T02:00:00.000Z',
      fieldPath: null,
    },
    candidate: makeCandidate({ id: 'qcwa-scholarship', name: 'QCWA Scholarship' }),
  });

  /**
   * `published: true` on an approved `vanished` means "the corpus was written",
   * and that write was a DELETION. Rendering it as "published" states the
   * opposite of what happened.
   */
  it('renders an approved vanished record as removed, never as published', async () => {
    stubFetch({ canDecide: true, rows: [vanished] });
    renderInbox();
    await userEvent.click(await screen.findByRole('button', { name: /^all$/i }));
    const item = await findItem(/QCWA Scholarship/);
    expect(item.textContent).toMatch(/removed from the corpus/i);
    expect(item.textContent).not.toMatch(/publish/i);
  });

  it('does not link an approved vanished record to a detail page that no longer exists', async () => {
    stubFetch({ canDecide: true, rows: [vanished] });
    renderInbox();
    await userEvent.click(await screen.findByRole('button', { name: /^all$/i }));
    const item = await findItem(/QCWA Scholarship/);
    expect(within(item).queryByRole('link', { name: /QCWA Scholarship/ })).not.toBeInTheDocument();
  });

  it('does not link a brand-new candidate that has not been approved into the corpus yet', async () => {
    stubFetch({
      canDecide: true,
      rows: [
        makeRow({
          changeEvent: {
            id: 'ce-3',
            sourceId: 'ardc-grants',
            programId: 'new-thing',
            kind: 'new',
            before: null,
            after: 'New Thing Grant',
            detectedAt: '2026-08-02T03:00:00.000Z',
            fieldPath: null,
          },
          candidate: makeCandidate({ id: 'new-thing', name: 'New Thing Grant' }),
        }),
      ],
    });
    renderInbox();
    const item = await findItem(/New Thing Grant/);
    expect(within(item).queryByRole('link', { name: /New Thing Grant/ })).not.toBeInTheDocument();
    expect(item.textContent).toMatch(/not in the corpus yet/i);
  });

  it('offers no decision controls on a row that has already been decided', async () => {
    stubFetch({ canDecide: true, rows: [vanished] });
    renderInbox();
    await userEvent.click(await screen.findByRole('button', { name: /^all$/i }));
    await findItem(/QCWA Scholarship/);
    expect(screen.queryByRole('button', { name: /^approve$/i })).not.toBeInTheDocument();
  });
});

describe('Inbox safety', () => {
  it('renders a candidate on a blocklisted host as a warning and never as a link', async () => {
    stubFetch({
      canDecide: true,
      rows: [
        makeRow({
          candidate: makeCandidate({
            id: 'far-farweb-org-compromised',
            name: 'Foundation for Amateur Radio (FAR) — domain compromised, do not apply',
            applyUrl: 'https://www.farweb.org/scholarships',
            tags: ['tier:D', 'safety_warning'],
          }),
        }),
      ],
    });
    renderInbox();
    const item = await findItem(/Foundation for Amateur Radio/);
    const links = within(item).queryAllByRole('link');
    for (const link of links) {
      expect(link.getAttribute('href')).not.toMatch(/farweb\.org/);
    }
    expect(within(item).getByRole('alert').textContent).toMatch(/farweb\.org/);
    expect(within(item).getByRole('alert').textContent).toMatch(/do not (visit|open)/i);
  });

  it('links an ordinary apply URL so the reviewer can check the claim at its source', async () => {
    stubFetch({ canDecide: true });
    renderInbox();
    const item = await findItem(/ARRL Foundation Scholarship Program/);
    expect(within(item).getByRole('link', { name: /arrl\.org/ })).toHaveAttribute(
      'href',
      'https://www.arrl.org/scholarship-program',
    );
  });
});

/**
 * `diff/index.ts` writes OBJECTS into `change_events.before_json`/`after_json` for four of the
 * six kinds it emits, and `inboxRouter`'s `text()` hands anything that is not a string to
 * `JSON.stringify`. The brief's fixture pretends both fields are short human strings.
 */
describe('Inbox change payloads that are not strings', () => {
  const DEADLINE_BEFORE = JSON.stringify({
    kind: 'annual_window',
    source: { kind: 'self' },
    note: 'Closes January 31.',
  });
  const DEADLINE_AFTER = JSON.stringify({
    kind: 'annual_window',
    source: { kind: 'self' },
    note: 'Closes December 30 at 12:00 PM EST.',
  });

  it('reads a DeadlineSpec payload as its note', () => {
    expect(describeChangeValue(DEADLINE_AFTER, 'deadline')).toBe(
      'Closes December 30 at 12:00 PM EST.',
    );
  });

  it('reads a whole-Program payload as the programme name', () => {
    expect(describeChangeValue(JSON.stringify(makeCandidate()), null)).toBe(
      'ARRL Foundation Scholarship Program',
    );
  });

  it('counts a constraints payload rather than printing it', () => {
    expect(describeChangeValue(JSON.stringify([{ axis: 'gpa' }, { axis: 'license' }]), 'constraints')).toBe(
      '2 eligibility rules',
    );
  });

  it('leaves a plain string payload alone', () => {
    expect(describeChangeValue('open', 'trust.status')).toBe('open');
    expect(describeChangeValue(null, null)).toBeNull();
  });

  it('renders the deadline notes rather than a wall of JSON', async () => {
    stubFetch({
      canDecide: true,
      rows: [
        makeRow({
          changeEvent: {
            id: 'ce-json',
            sourceId: 'arrl-scholarship-descriptions',
            programId: 'arrl-foundation-scholarship',
            kind: 'deadline_changed',
            before: DEADLINE_BEFORE,
            after: DEADLINE_AFTER,
            detectedAt: '2026-08-02T03:17:00.000Z',
            fieldPath: 'deadline',
          },
        }),
      ],
    });
    renderInbox();
    const item = await findItem(/ARRL Foundation Scholarship Program/);
    expect(within(item).getByText('Closes January 31.')).toBeInTheDocument();
    expect(within(item).getByText('Closes December 30 at 12:00 PM EST.')).toBeInTheDocument();
    // The braces exist, but only inside a disclosure that starts closed — the row a reviewer
    // scans is the two notes, not the serialised DeadlineSpec.
    const details = within(item).getByText(/"annual_window"/).closest('details');
    expect(details).not.toBeNull();
    expect(details?.hasAttribute('open')).toBe(false);
  });

  it('still offers the exact payload it summarised from', async () => {
    stubFetch({
      canDecide: true,
      rows: [
        makeRow({
          changeEvent: {
            id: 'ce-json',
            sourceId: 'arrl-scholarship-descriptions',
            programId: 'arrl-foundation-scholarship',
            kind: 'deadline_changed',
            before: DEADLINE_BEFORE,
            after: DEADLINE_AFTER,
            detectedAt: '2026-08-02T03:17:00.000Z',
            fieldPath: 'deadline',
          },
        }),
      ],
    });
    renderInbox();
    const item = await findItem(/ARRL Foundation Scholarship Program/);
    const raw = within(item).getByText(/annual_window/);
    expect(raw.textContent).toContain(DEADLINE_BEFORE);
    expect(raw.textContent).toContain(DEADLINE_AFTER);
  });

  it('offers no raw payload when there was nothing to summarise', async () => {
    stubFetch({ canDecide: true });
    renderInbox();
    const item = await findItem(/ARRL Foundation Scholarship Program/);
    expect(within(item).queryByText(/summarised from/i)).not.toBeInTheDocument();
  });
});

describe('Inbox queue size', () => {
  it('counts what is loaded and what is waiting', () => {
    const rows = [makeRow(), makeRow({ id: 'ri-2', decision: 'approved' })];
    expect(queueSummary(rows)).toBe('2 review items loaded · 1 waiting for a decision.');
  });

  it('uses the singular for one item', () => {
    expect(queueSummary([makeRow()])).toBe('1 review item loaded · 1 waiting for a decision.');
  });

  /**
   * `GET /api/inbox` caps at 500 and does not page. A bare "500 review items"
   * would state the cap as if it were the size of the queue.
   */
  it('says the cap is a limit on this page, not the size of the queue, when it is hit', () => {
    const rows = Array.from({ length: QUEUE_CAP }, (_v, i) => makeRow({ id: `ri-${String(i)}` }));
    expect(queueSummary(rows)).toMatch(/newest 500/);
    expect(queueSummary(rows)).toMatch(/may hold more/i);
    expect(queueSummary(rows)).not.toMatch(/^500 review items loaded/);
  });
});

describe('Inbox states', () => {
  it('says the queue is empty rather than rendering nothing', async () => {
    stubFetch({ canDecide: true, rows: [] });
    renderInbox();
    expect(await screen.findByText(/nothing is waiting for review/i)).toBeInTheDocument();
  });

  it('reports a failure to load the queue', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    renderInbox();
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be reached/i);
  });

  it('hides decided rows until the reviewer asks for them', async () => {
    stubFetch({
      canDecide: true,
      rows: [makeRow({ id: 'ri-decided', decision: 'rejected', decidedBy: 'admin@example.com' })],
    });
    renderInbox();
    expect(await screen.findByText(/nothing is waiting for review/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^all$/i }));
    expect(await findItem(/ARRL Foundation Scholarship Program/)).toBeInTheDocument();
  });
});
