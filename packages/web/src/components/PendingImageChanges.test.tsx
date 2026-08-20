/**
 * WHAT AN OPERATOR SEES BEFORE THEY CONSENT.
 *
 * The server decides what may be applied; this file is about the other half, which is just as
 * load-bearing and is the half a screen can get wrong on its own: that the page shows the funder's
 * sentence, the rule that moves, and who it moves — and that no button can send anything until
 * both a specific change is ticked and the word is typed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PendingImageChanges } from './PendingImageChanges.js';

const RULES_PROPOSAL = {
  id: 'proposal-rules-dara',
  kind: 'rules',
  programId: 'dara-grantmaker-only-via-arrl',
  programName: 'DARA / Hamvention',
  funderName: 'Dayton Amateur Radio Association',
  sourceUrl: 'https://www.arrl.org/scholarship-descriptions',
  changes: [
    {
      constraintId: 'dara-institution',
      change: 'changed',
      sentence:
        'Any licence class, any region, any field of study; must be enrolled at an accredited four-year institution.',
      fields: [{ field: 'spec.degreeLevels', before: '["BACH"]', after: '["BACH","GRAD"]' }],
    },
  ],
  impact: {
    profilesMeasured: 4,
    moves: [{ before: 'refused', after: 'eligible', count: 2 }],
  },
};

const WORDING_PROPOSAL = {
  id: 'proposal-wording-arrl',
  kind: 'wording',
  programId: 'arrl-foundation-scholarships',
  programName: 'ARRL Foundation Scholarship Program',
  funderName: 'ARRL Foundation',
  sourceUrl: 'https://www.arrl.org/scholarship-program',
  path: 'deadline.note',
  from: 'RECUR annual_window tz=America/New_York window=10-30..12-30 close=12:00 | ARRL publishes no closing time.',
  to: 'RECUR annual_window tz=America/New_York window=10-30..12-30 | ARRL publishes no closing time.',
  fromFirstSeen: '2026-08-04',
  deadline: {
    before: 'October 30 to December 30 each year, 00:00 to 12:00 America/New_York',
    after: 'October 30 to December 30 each year, 00:00 to 23:59 America/New_York',
    observedBefore: null,
    observedAfter: null,
    nextCloseBefore: '2026-12-30T17:00:00.000Z',
    nextCloseAfter: '2026-12-31T04:59:00.000Z',
    inheritedBy: 112,
  },
  impact: { profilesMeasured: 4, moves: [] },
};

const ADDITION = {
  id: 'proposal-record-special-funds',
  kind: 'record',
  programId: 'arrl-foundation-special-funds',
  programName: 'ARRL Foundation Special Funds',
  funderName: 'ARRL Foundation',
  sourceUrl: 'https://www.arrl.org/arrl-foundation-special-funds',
  summary: 'One ARRL page carrying three separately endowed funds.',
  klass: 'ham_grant',
  applyUrl: 'https://www.arrl.org/amateur-radio-grants',
  amountRaw: 'not to exceed $1,000 per grant',
  deadlineNote: 'RECUR n_fixed_dates tz=America/New_York dates=10-01',
  constraintCount: 4,
  addsFunder: null,
  impact: {
    profilesMeasured: 4,
    moves: [{ before: 'not listed on this instance', after: 'eligible', count: 1 }],
  },
};

const PLAN = {
  ran: true,
  wording: [WORDING_PROPOSAL],
  rules: [RULES_PROPOSAL],
  additions: [ADDITION],
  notOffered: [
    {
      programId: 'some-record',
      path: 'summary',
      reason: 'not-a-value-this-project-shipped',
      why: 'your copy is not the text GrantSpotter shipped',
    },
  ],
  profilesMeasured: 4,
  examined: 143,
  ledgerSize: 1997,
};

type Body = Record<string, unknown>;
const sent: Array<{ url: string; body: Body }> = [];

function stubFetch(plan: unknown = PLAN, applied: unknown = { ran: true, applied: [], refused: [], programsReindexed: 143 }) {
  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      sent.push({ url, body: JSON.parse(String(init.body)) as Body });
      return Promise.resolve({ ok: true, status: 200, json: async () => applied });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => plan });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  sent.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Pending changes from the image', () => {
  it('quotes the funder’s sentence and names the rule that moves', async () => {
    stubFetch();
    render(<PendingImageChanges />);

    expect(
      await screen.findByText(
        /Any licence class, any region, any field of study; must be enrolled at an accredited four-year institution\./,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('spec.degreeLevels')).toBeInTheDocument();
    expect(screen.getByText('["BACH"]')).toBeInTheDocument();
    expect(screen.getByText('["BACH","GRAD"]')).toBeInTheDocument();
  });

  /** "Apply 3 corrections?" is not consent. This is the sentence that makes it one. */
  it('says who this record refuses today and will not afterwards', async () => {
    stubFetch();
    render(<PendingImageChanges />);

    const list = await screen.findByRole('list', { name: 'Pending corrections' });
    const moved = within(list).getByText(/today this record tells them/i);
    expect(moved).toHaveTextContent(
      '2 of 4 applicant profiles saved here: today this record tells them refused; afterwards it tells them eligible.',
    );
  });

  it('names the deadline a note moves, and how many records move with it', async () => {
    stubFetch();
    render(<PendingImageChanges />);

    expect(await screen.findByText(/2026-12-30T17:00:00.000Z/)).toBeInTheDocument();
    expect(screen.getByText(/2026-12-31T04:59:00.000Z/)).toBeInTheDocument();
    expect(
      screen.getByText(/112 other records take their deadline from this one/),
    ).toBeInTheDocument();
  });

  /**
   * The honest empty answer. An instance with no saved profiles is told it measured nothing, not
   * shown a blank space that reads as "nothing moves".
   */
  it('says nothing was measured when no applicant profile is saved here', async () => {
    stubFetch({
      ...PLAN,
      profilesMeasured: 0,
      wording: [],
      additions: [],
      rules: [{ ...RULES_PROPOSAL, impact: { profilesMeasured: 0, moves: [] } }],
    });
    render(<PendingImageChanges />);

    expect(
      await screen.findByText(/No applicant profile is saved on this instance, so no verdict/),
    ).toBeInTheDocument();
  });

  it('sends nothing until a change is ticked AND the word is typed', async () => {
    stubFetch();
    render(<PendingImageChanges />);
    const apply = await screen.findByRole('button', { name: /Apply .*ticked correction/ });
    expect(apply).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/Type CORRECT to confirm/), 'CORRECT');
    expect(apply).toBeDisabled();

    await userEvent.click(
      screen.getByLabelText(/Apply the eligibility rule change for DARA \/ Hamvention/),
    );
    expect(apply).toBeEnabled();
    expect(sent).toHaveLength(0);
  });

  it('sends only the ticked changes, by id', async () => {
    stubFetch();
    render(<PendingImageChanges />);
    await screen.findByRole('button', { name: /Apply .*ticked correction/ });

    await userEvent.click(
      screen.getByLabelText(/Apply the eligibility rule change for DARA \/ Hamvention/),
    );
    await userEvent.type(screen.getByLabelText(/Type CORRECT to confirm/), 'CORRECT');
    await userEvent.click(screen.getByRole('button', { name: /Apply .*ticked correction/ }));

    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]!.url).toBe('/api/admin/seed-corrections/apply');
    expect(sent[0]!.body).toEqual({
      confirm: 'CORRECT',
      proposalIds: [RULES_PROPOSAL.id],
    });
  });

  /**
   * ADDING A PROGRAMME IS A SEPARATE ACT, and the page has to make that visible: a separate list,
   * a separate word, and a button that cannot reach the corrections endpoint.
   */
  it('keeps additions on their own list, with their own word and their own endpoint', async () => {
    stubFetch();
    render(<PendingImageChanges />);

    const list = await screen.findByRole('list', { name: 'Programmes the image would add' });
    expect(within(list).getByText('ARRL Foundation Special Funds')).toBeInTheDocument();

    await userEvent.click(screen.getByLabelText('Add ARRL Foundation Special Funds'));
    await userEvent.type(screen.getByLabelText(/Type ADD to confirm/), 'ADD');
    await userEvent.click(screen.getByRole('button', { name: /Add .*ticked programme/ }));

    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]!.url).toBe('/api/admin/seed-corrections/add');
    expect(sent[0]!.body).toEqual({ confirm: 'ADD', proposalIds: [ADDITION.id] });
  });

  it('says an addition is not a correction, and that a decline is not remembered', async () => {
    stubFetch();
    render(<PendingImageChanges />);
    expect(await screen.findByText(/These are not corrections/)).toBeInTheDocument();
    expect(
      screen.getByText(/GrantSpotter does not remember that you declined/),
    ).toBeInTheDocument();
  });

  it('lists what neither door will change, so the page is a whole picture', async () => {
    stubFetch();
    render(<PendingImageChanges />);
    expect(
      await screen.findByText(/1 difference is not offered here at all/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/your copy is not the text GrantSpotter shipped/),
    ).toBeInTheDocument();
  });

  it('reports a reconcile that could not run, instead of an empty page', async () => {
    stubFetch({
      ran: false,
      wording: [],
      rules: [],
      additions: [],
      notOffered: [],
      profilesMeasured: 0,
      examined: 0,
      ledgerSize: 0,
      error: 'shipped-values.tsv line 12: "nonsense" is not a sha256 digest.',
    });
    render(<PendingImageChanges />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/nothing is offered and nothing was written/);
    expect(alert).toHaveTextContent(/is not a sha256 digest/);
  });

  it('says nothing is outstanding when the deployment already holds everything', async () => {
    stubFetch({
      ran: true,
      wording: [],
      rules: [],
      additions: [],
      notOffered: [],
      profilesMeasured: 2,
      examined: 144,
      ledgerSize: 1997,
    });
    render(<PendingImageChanges />);

    expect(
      await screen.findByText(/Nothing is outstanding: this deployment already holds everything/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Apply/ })).not.toBeInTheDocument();
  });

  /**
   * THE SUMMARY LINE, WHICH IS THE ONLY THING A HURRIED OPERATOR READS. Every number in it is a
   * claim: how much was compared, against how much evidence, how much is waiting, and how much of
   * that moves an answer somebody is given.
   */
  it('counts what was compared, what is waiting, and how much of it moves a verdict', async () => {
    stubFetch();
    render(<PendingImageChanges />);

    expect(
      await screen.findByText(/143 shipped records checked against 1997 recorded values/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /2 corrections are waiting, 1 of which move a verdict for somebody with a profile here, and 1 programme would be added\./,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Every movement below was measured by running the real matcher over the 4 applicant profiles saved on this instance, before and after. No applicant is invented and none is named/,
      ),
    ).toBeInTheDocument();
  });

  it('states the rule it applies before any of it: what a record says, and not what it means', async () => {
    stubFetch();
    render(<PendingImageChanges />);
    const intro = await screen.findByText(/A change that would move a deadline, an amount/);
    expect(intro).toHaveTextContent(/changes what the record/);
    expect(intro).toHaveTextContent(/and not what it/);
  });

  it('says a change moves nobody, rather than leaving the space blank', async () => {
    stubFetch();
    render(<PendingImageChanges />);
    expect(
      await screen.findByText(
        /No verdict moves: all 4 applicant profiles saved here are told the same thing before and after/,
      ),
    ).toBeInTheDocument();
  });

  /**
   * The singular halves of every count, which is where a page usually reads as machine output.
   * "1 correction is waiting" and "1 difference is not offered" are both on this path.
   */
  it('reads as English when there is exactly one of everything', async () => {
    stubFetch({
      ...PLAN,
      wording: [],
      additions: [],
      rules: [{ ...RULES_PROPOSAL, impact: { profilesMeasured: 1, moves: [] } }],
      profilesMeasured: 1,
      examined: 1,
      ledgerSize: 1,
    });
    render(<PendingImageChanges />);

    expect(
      await screen.findByText(/1 shipped record checked against 1 recorded value/),
    ).toBeInTheDocument();
    expect(screen.getByText(/1 correction is waiting/)).toBeInTheDocument();
    expect(
      screen.getByText(/the 1 applicant profile saved on this instance, before and after/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/No verdict moves: all 1 applicant profile saved here/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply 0 ticked corrections' })).toBeDisabled();
  });

  /** A field a rule did not carry before, or does not carry after, is "not set" — never blank. */
  it('names a rule field that is absent on one side rather than showing an empty cell', async () => {
    stubFetch({
      ...PLAN,
      wording: [],
      additions: [],
      rules: [
        {
          ...RULES_PROPOSAL,
          changes: [
            {
              constraintId: 'dara-institution',
              change: 'added',
              sentence: '',
              fields: [{ field: 'spec.orUnrepresented', before: null, after: '"four-year"' }],
            },
          ],
        },
      ],
    });
    render(<PendingImageChanges />);

    expect(await screen.findByText('not set')).toBeInTheDocument();
    expect(screen.getByText(/a requirement the image ADDS/)).toBeInTheDocument();
    // A rule with no funder sentence behind it is SAID, not silently omitted: this panel exists
    // because a rule and the words it claims to encode had come apart.
    expect(
      screen.getByText(/No funder sentence is recorded against this requirement/),
    ).toBeInTheDocument();
  });

  it('says when a note projects no deadline and states no window at all', async () => {
    stubFetch({
      ...PLAN,
      rules: [],
      additions: [],
      wording: [
        {
          ...WORDING_PROPOSAL,
          deadline: {
            ...WORDING_PROPOSAL.deadline,
            observedBefore: '2026-10-30 to 2026-12-30',
            observedAfter: null,
            nextCloseBefore: null,
            nextCloseAfter: null,
            inheritedBy: 1,
          },
        },
      ],
    });
    render(<PendingImageChanges />);

    expect(await screen.findAllByText('none projected')).toHaveLength(2);
    expect(screen.getByText('none stated')).toBeInTheDocument();
    expect(
      screen.getByText(/One other record takes its deadline from this one and moves with it/),
    ).toBeInTheDocument();
  });

  it('labels the wording correction by the record it belongs to', async () => {
    stubFetch();
    render(<PendingImageChanges />);
    expect(
      await screen.findByLabelText(
        'Apply the wording correction for ARRL Foundation Scholarship Program',
      ),
    ).toBeInTheDocument();
  });

  it('ticks every correction at once, and sends exactly those ids', async () => {
    stubFetch();
    render(<PendingImageChanges />);
    await userEvent.click(await screen.findByRole('button', { name: 'Tick every correction' }));
    await userEvent.type(screen.getByLabelText(/Type CORRECT to confirm/), 'CORRECT');
    await userEvent.click(screen.getByRole('button', { name: /Apply 2 ticked corrections/ }));

    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect((sent[0]!.body as { proposalIds: string[] }).proposalIds.sort()).toEqual(
      [WORDING_PROPOSAL.id, RULES_PROPOSAL.id].sort(),
    );
  });

  it('names the funder an addition brings with it', async () => {
    stubFetch({
      ...PLAN,
      wording: [],
      rules: [],
      additions: [{ ...ADDITION, addsFunder: 'The Quarter Century Wireless Association' }],
    });
    render(<PendingImageChanges />);
    expect(
      await screen.findByText(
        /This also adds the funder The Quarter Century Wireless Association, which this instance does not hold/,
      ),
    ).toBeInTheDocument();
  });

  /**
   * A REFUSAL IS NOT AN ERROR AND IS NOT SILENCE. The server may land some changes and refuse
   * others in one answer, and the operator is owed both halves — including the sentence that says
   * the audit log has the whole of what was replaced.
   */
  it('reports what was applied and what was refused, in one notice', async () => {
    stubFetch(PLAN, {
      ran: true,
      applied: [
        {
          id: RULES_PROPOSAL.id,
          kind: 'rules',
          programId: 'dara-grantmaker-only-via-arrl',
          programName: 'DARA / Hamvention',
          what: 'eligibility rules updated',
        },
      ],
      refused: [{ id: 'stale', why: 'That change is no longer being offered.' }],
      programsReindexed: 143,
    });
    render(<PendingImageChanges />);
    await userEvent.click(
      await screen.findByLabelText(/Apply the eligibility rule change for DARA \/ Hamvention/),
    );
    await userEvent.type(screen.getByLabelText(/Type CORRECT to confirm/), 'CORRECT');
    await userEvent.click(screen.getByRole('button', { name: /Apply 1 ticked correction/ }));

    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent(/1 change applied/);
    expect(notice).toHaveTextContent(/1 change was refused/);
    expect(notice).toHaveTextContent(/The browse index was rebuilt for 143 programmes/);
    expect(notice).toHaveTextContent(
      /Every one of them is in the audit log with the whole of the text it replaced/,
    );
  });

  it('reports two refusals as two, not as one', async () => {
    stubFetch(PLAN, {
      ran: true,
      applied: [],
      refused: [
        { id: 'a', why: 'One reason.' },
        { id: 'b', why: 'Another reason.' },
      ],
      programsReindexed: null,
    });
    render(<PendingImageChanges />);
    await userEvent.click(
      await screen.findByLabelText(/Apply the eligibility rule change for DARA \/ Hamvention/),
    );
    await userEvent.type(screen.getByLabelText(/Type CORRECT to confirm/), 'CORRECT');
    await userEvent.click(screen.getByRole('button', { name: /Apply 1 ticked correction/ }));

    expect(await screen.findByRole('status')).toHaveTextContent(/2 changes were refused/);
  });

  it('says the request failed rather than appearing to have worked', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) =>
        init?.method === 'POST'
          ? Promise.reject(new TypeError('network down'))
          : Promise.resolve({ ok: true, status: 200, json: async () => PLAN }),
      ),
    );
    render(<PendingImageChanges />);
    await userEvent.click(
      await screen.findByLabelText(/Apply the eligibility rule change for DARA \/ Hamvention/),
    );
    await userEvent.type(screen.getByLabelText(/Type CORRECT to confirm/), 'CORRECT');
    await userEvent.click(screen.getByRole('button', { name: /Apply 1 ticked correction/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /That change could not be applied/,
    );
  });

  it('says it is reading the image rather than showing an empty panel', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
    render(<PendingImageChanges />);
    expect(await screen.findByText('Reading the image…')).toBeInTheDocument();
  });

  it('reports a reconcile that failed without saying why as exactly that', async () => {
    stubFetch({
      ran: false,
      wording: [],
      rules: [],
      additions: [],
      notOffered: [],
      profilesMeasured: 0,
      examined: 0,
      ledgerSize: 0,
    });
    render(<PendingImageChanges />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/unknown error/);
  });

  it('counts more than one un-offered difference as more than one', async () => {
    stubFetch({
      ...PLAN,
      notOffered: [
        ...PLAN.notOffered,
        {
          programId: 'another-record',
          path: 'deadline.note',
          reason: 'changes-what-the-record-means',
          why: 'the shipped corpus dropped this field',
        },
      ],
    });
    render(<PendingImageChanges />);
    expect(
      await screen.findByText(/2 differences are not offered here at all/),
    ).toBeInTheDocument();
  });
});
