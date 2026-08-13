import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { Program } from '@grantspotter/core';
import { Inbox, QUEUE_CAP, describeChangeValue, queueSummary, statedWindowLoss } from './Inbox.js';
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

    // ...AND IT SAYS WHO. A decided row's whole reason for still being reachable is the audit
    // trail, so the attribution is part of the claim and not decoration. `userFacingCopyContract`
    // found this line named by no test in the repository — its only "coverage" was the phrase
    // "decided by a coordinate" inside an unrelated comment in `e2e/api.spec.ts`, which stopped
    // existing when that comment was rewritten. An accidental substring is not an assertion, which
    // is exactly what that ratchet exists to expose.
    expect(await screen.findByText(/decided by/i)).toBeInTheDocument();
    expect(await screen.findByText('admin@example.com')).toBeInTheDocument();
  });
});

/**
 * THE MACHINE DIRECTIVE, AND THE RULE AN ADMINISTRATOR COULD DELETE WITHOUT BEING SHOWN IT.
 *
 * MEASURED on the SHIPPED corpus (`data/seed/`, the 143 records a fresh install serves), with a
 * pending review item injected for `arrl-foundation-scholarships` and the screen walked in
 * Chromium at 1280x900:
 *
 *   AS A MEMBER — this queue is `requireAuth`, not `requireAdmin`, so this is a student — the one
 *   card printed `RECUR annual_window tz=America/New_York window=10-30..12-30 close=12:00 |` THREE
 *   times: once on each side of the before→after arrow (`deadline_changed` carries the whole
 *   `DeadlineSpec`, and `describeChangeValue` returned `record.note` raw) and once under "Deadline
 *   note". `cc64182` had removed the identical string from the record page eight commits earlier.
 *
 *   AS AN ADMINISTRATOR, the same string was PRE-FILLED into a textarea labelled only "Deadline
 *   note", under a hint that said the note was the editable part and nothing that said the first
 *   segment was a rule. Deleting the `RECUR …|` prefix and keeping the sentence — what tidying a
 *   note looks like — and pressing "Save and approve" took the record's projected cycles from 2 to
 *   0, its 112 inheritors' from 224 to 0, and the whole `cycles` table from 243 rows to 17. The
 *   screen reported "Edited by hand and written to the corpus."
 *
 * Every figure above was reproduced on the fixture corpus too (150 publishable / 553 suppressed),
 * where the same record is `arrl-scholarship-program--scholarship-program--7b29405e`: 2 → 0, 224 →
 * 0, 244 → 18.
 */
const RECUR_NOTE =
  'RECUR annual_window tz=America/New_York window=10-30..12-30 close=12:00 | ' +
  'Opens about Oct 30 and closes Dec 30. ARRL publishes no closing time on either captured page.';

const PROSE_ONLY =
  'Opens about Oct 30 and closes Dec 30. ARRL publishes no closing time on either captured page.';

function recurRow(over: Partial<Program['deadline']> = {}): InboxRow {
  return makeRow({
    candidate: makeCandidate({
      deadline: {
        kind: 'annual_window',
        source: { kind: 'self' },
        note: RECUR_NOTE,
        ...over,
      },
    }),
  });
}

describe('the RECUR directive on a queued candidate', () => {
  it('is not printed at the member reading the queue, in any of the three places it used to be', async () => {
    stubFetch({ canDecide: false, rows: [recurRow()] });
    renderInbox();
    const item = await findItem(/ARRL Foundation Scholarship Program/);
    // The summary line, both halves of the arrow, and the note line — everything the card renders
    // outside the "exact payload" disclosure, which exists to carry the payload verbatim.
    const shown = item.textContent ?? '';
    expect(shown).not.toMatch(/RECUR /);
    expect(shown).not.toMatch(/tz=America/);
    expect(shown).not.toMatch(/window=10-30/);
  });

  it('is read to the member as a schedule instead, in the record page’s own words', async () => {
    stubFetch({ canDecide: false, rows: [recurRow()] });
    renderInbox();
    const item = await findItem(/ARRL Foundation Scholarship Program/);
    expect(within(item).getByText(/^Repeats:/)).toHaveTextContent(
      'Repeats: October 30 to December 30 each year, 00:00 to 12:00 America/New_York',
    );
    expect(within(item).getByText(/^Deadline note:/)).toHaveTextContent(
      `Deadline note: ${PROSE_ONLY}`,
    );
  });

  /**
   * A DIRECTIVE THAT DOES NOT PARSE IS SAID TO BE UNREADABLE, NOT GUESSED AT AND NOT HIDDEN.
   * `Opportunity.tsx` drops it silently, which is right for a record page; this is the screen
   * whose job is inspecting candidates, and a reviewer deciding whether to approve one needs to
   * know that no date will come out of it.
   */
  it('says so when the rule cannot be read, without printing the rule', async () => {
    stubFetch({
      canDecide: false,
      rows: [recurRow({ note: 'RECUR n_fixed_dates tz=Mars/Olympus dates=02-01 | Ask them.' })],
    });
    renderInbox();
    const item = await findItem(/ARRL Foundation Scholarship Program/);
    expect(item.textContent).toContain(
      'This candidate carries a repeat rule GrantSpotter cannot read, so it projects no dates from it.',
    );
    expect(item.textContent).not.toMatch(/Mars\/Olympus|RECUR /);
    expect(within(item).queryByText(/^Repeats:/)).not.toBeInTheDocument();
  });

  it('is summarised, not dumped, when the change event carries a whole DeadlineSpec', () => {
    const spec = JSON.stringify({ kind: 'annual_window', source: { kind: 'self' }, note: RECUR_NOTE });
    expect(describeChangeValue(spec, 'deadline')).toBe(PROSE_ONLY);
  });

  it('falls back to the deadline kind IN WORDS when the note is empty, not to the enum', () => {
    const spec = JSON.stringify({ kind: 'n_fixed_windows', source: { kind: 'self' }, note: '' });
    expect(describeChangeValue(spec, 'deadline')).toBe('Several application windows each year');
  });

  it('falls back to the rule when the note is nothing but a directive', () => {
    const spec = JSON.stringify({
      kind: 'n_fixed_dates',
      source: { kind: 'self' },
      note: 'RECUR n_fixed_dates tz=UTC dates=02-01',
    });
    expect(describeChangeValue(spec, 'deadline')).toBe(
      'February 1 each year, closing at 23:59 UTC',
    );
  });
});

describe('the edit panel, which used to hand an administrator the rule to delete', () => {
  async function openEdit(rows: InboxRow[] = [recurRow()]): Promise<{
    fetchMock: ReturnType<typeof vi.fn>;
    panel: HTMLElement;
  }> {
    const fetchMock = stubFetch({ canDecide: true, rows });
    renderInbox();
    await userEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    return { fetchMock, panel: await findItem(/ARRL Foundation Scholarship Program/) };
  }

  it('pre-fills the box with the funder’s sentences and NOT with the directive', async () => {
    await openEdit();
    expect(screen.getByLabelText(/deadline note/i)).toHaveValue(PROSE_ONLY);
  });

  it('shows the rule it is keeping, in words and verbatim, so nothing is preserved in secret', async () => {
    const { panel } = await openEdit();
    expect(panel.textContent).toContain(
      'Repeat rule — kept exactly as it is, and not editable here',
    );
    expect(panel.textContent).toContain(
      'October 30 to December 30 each year, 00:00 to 12:00 America/New_York',
    );
    // The directive itself, so an administrator can see the exact string that travels with the
    // edit. This is the one place on the screen it belongs: an admin-only panel about it.
    expect(panel.textContent).toContain(
      'RECUR annual_window tz=America/New_York window=10-30..12-30 close=12:00',
    );
  });

  it('says what the rule does and who else it moves, not merely that it is locked', async () => {
    const { panel } = await openEdit();
    expect(panel.textContent).toContain(
      'This is what GrantSpotter reads to generate every future date it publishes for this ' +
        'programme, including for any record that inherits this deadline. It travels with your ' +
        'edit unchanged, and the server refuses an edit that changes it. A rule that is wrong is ' +
        'a fix to the source.',
    );
    expect(panel.textContent).toContain(
      'Only these sentences are editable here. Anything else wrong with this record is a fix to ' +
        'its source, not to one queued candidate.',
    );
  });

  it('keeps the rule on the note it posts, however the reviewer rewrites the sentences', async () => {
    const { fetchMock } = await openEdit();
    const field = screen.getByLabelText(/deadline note/i);
    await userEvent.clear(field);
    await userEvent.type(field, 'Closes Dec 30, hand-checked against the ARRL portal.');
    await userEvent.click(screen.getByRole('button', { name: /save and approve/i }));
    await waitFor(() => {
      expect(postBody(fetchMock).decision).toBe('edited');
    });
    const candidate = postBody(fetchMock).candidate as Program;
    expect(candidate.deadline.note).toBe(
      'RECUR annual_window tz=America/New_York window=10-30..12-30 close=12:00 | ' +
        'Closes Dec 30, hand-checked against the ARRL portal.',
    );
  });

  /**
   * THE GESTURE THAT DESTROYED THE RULE, MADE HARMLESS. Clearing the box entirely is the widest
   * version of "delete the note and retype it", and it must still not be able to take the rule
   * with it — the note posts as the directive alone, which `parseRecurrence` reads identically.
   */
  it('keeps the rule even when the reviewer empties the box', async () => {
    const { fetchMock } = await openEdit();
    await userEvent.clear(screen.getByLabelText(/deadline note/i));
    await userEvent.click(screen.getByRole('button', { name: /save and approve/i }));
    await waitFor(() => {
      expect(postBody(fetchMock).decision).toBe('edited');
    });
    expect((postBody(fetchMock).candidate as Program).deadline.note).toBe(
      'RECUR annual_window tz=America/New_York window=10-30..12-30 close=12:00',
    );
  });

  it('keeps a directive it cannot read, which is the one it must not be trusted to re-type', async () => {
    const { fetchMock } = await openEdit([
      recurRow({ note: 'RECUR n_fixed_dates tz=Mars/Olympus dates=02-01 | Ask them.' }),
    ]);
    const panel = await findItem(/ARRL Foundation Scholarship Program/);
    expect(panel.textContent).toContain(
      'GrantSpotter cannot read this rule, so it projects no dates from it. It is kept anyway, unchanged.',
    );
    await userEvent.click(screen.getByRole('button', { name: /save and approve/i }));
    await waitFor(() => {
      expect(postBody(fetchMock).decision).toBe('edited');
    });
    expect((postBody(fetchMock).candidate as Program).deadline.note).toBe(
      'RECUR n_fixed_dates tz=Mars/Olympus dates=02-01 | Ask them.',
    );
  });

  it('shows no rule panel at all for a note that carries none', async () => {
    const { panel } = await openEdit([makeRow()]);
    expect(panel.textContent).not.toContain('Repeat rule');
    expect(screen.getByLabelText(/deadline note/i)).toHaveValue('Closes Dec 30 at 12:00 PM EST.');
  });
});

/**
 * THE OTHER LOAD-BEARING THING IN THE SAME FIELD. `parseObservedWindow` reads `opens YYYY-MM-DD` /
 * `closes YYYY-MM-DD` back out of the sentence after `published by the funder:`, and
 * `observedCycles` turns it into the only kind of cycle this product marks `isEstimated: false`.
 * Three shipped records carry one. It is PROSE, so it stays in the box an administrator may edit —
 * but it may not leave without being named, which is the whole complaint about the directive said
 * about the half that cannot be locked.
 */
describe('statedWindowLoss', () => {
  const STATED =
    'Applications open in the autumn — published by the funder: opens 2026-07-01, ' +
    'closes 2026-09-30. The page prints no year.';

  it('is silent when the note never stated a window', () => {
    expect(statedWindowLoss('Closes Dec 30 at 12:00 PM EST.', 'Closes Dec 30.')).toBeNull();
  });

  it('is silent when the reviewer left the stated window alone', () => {
    expect(statedWindowLoss(STATED, `${STATED} Checked 2026-08-13.`)).toBeNull();
  });

  it('names the dates that would stop being published, and whose they are', () => {
    const warning = statedWindowLoss(STATED, 'Applications open in the autumn.');
    expect(warning).toBe(
      'GrantSpotter reads a window the funder itself published out of this note (opens ' +
        '2026-07-01, closes 2026-09-30) and puts it on the calendar as the one date on it nobody ' +
        'projected. These sentences no longer state it, so saving removes that date. Right if ' +
        'the funder withdrew the window; wrong if you were tidying the wording.',
    );
  });

  it('says the date MOVED rather than went, when the reviewer restated it differently', () => {
    const warning = statedWindowLoss(
      STATED,
      'published by the funder: opens 2026-07-01, closes 2026-10-31.',
    );
    expect(warning).toBe(
      'GrantSpotter reads a window the funder itself published out of this note (opens ' +
        '2026-07-01, closes 2026-09-30) and puts it on the calendar as the one date on it nobody ' +
        'projected. These sentences now state opens 2026-07-01, closes 2026-10-31 instead, so ' +
        'saving moves that date.',
    );
  });

  it('reaches the reviewer as an alert on the panel, before they press Save', async () => {
    stubFetch({ canDecide: true, rows: [recurRow({ note: `RECUR annual_window tz=America/New_York window=07-01..09-30 | ${STATED}` })] });
    renderInbox();
    await userEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    const field = screen.getByLabelText(/deadline note/i);
    await userEvent.clear(field);
    await userEvent.type(field, 'Applications open in the autumn.');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /no longer state it, so saving removes that date/,
    );
  });
});
