import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Cycle, Obligations } from '@grantspotter/core';
import { Opportunity } from './Opportunity.js';

/**
 * The detail page is where spec §8's honesty surfaces all land at once, so most of what is
 * asserted below is a claim about what the product REFUSES to say:
 *
 *  - an obligation nobody stated never renders as "not required" (148 of 150 records),
 *  - an empty provenance list never renders as an empty table (all 150 records today),
 *  - a projected cycle never renders as a funder-published one (239 of 243 cycles),
 *  - a deadline never renders in the wrong calendar day (every US deadline is a UTC instant
 *    of a 23:59 LOCAL wall time),
 *  - a blocklisted host never renders as a clickable link (farweb.org now 301s to a gambling
 *    site, and QCWA/ARRL/club pages still tell applicants to "apply at the FAR website"),
 *  - a refused fetch never renders as a fresh verification.
 */

const OBLIGATIONS_UNSTATED: Obligations = {
  licenseObligation: 'All output must be open-source / open-access.',
  indirectCostCapPct: 20,
  // costShareRequired and coFunderPreference are ABSENT. That is the real corpus shape — see
  // core's `obligationState` and CONTRACT §3 amendment 7.
};

const CLUB_GRANT_DETAIL = {
  program: {
    id: 'arrl-club-grant',
    funderId: 'arrl-foundation',
    name: 'ARRL Club Grant Program',
    klass: 'ham_grant',
    summary: 'ARDC-funded grants to ARRL-affiliated clubs.',
    applicantEntities: ['club_501c3', 'club_unincorporated'],
    amount: {
      instrument: 'cash_range',
      amountMin: 1000,
      amountMax: 25000,
      amountRaw: '$1,000 - $25,000',
      awardCountRaw: '37 in 2024',
    },
    deadline: {
      kind: 'unpublished',
      source: { kind: 'self' },
      note: 'The deadline is not published on the page.',
    },
    applyVia: 'external_spa_portal',
    applyUrl: 'https://www.arrl.org/club-grant-program',
    constraints: [],
    fundingRestrictions: ['No emergency communications equipment.', 'No ongoing operating expenses.'],
    obligations: OBLIGATIONS_UNSTATED,
    aiPolicy: {
      stance: 'permitted',
      quote:
        'If you choose to use AI when writing your proposal be sure to thoroughly edit for clarity, brevity, and accuracy.',
      url: 'https://www.ardc.net/apply/grant-application-instructions/',
    },
    trust: {
      status: 'unknown',
      sourceUrl: 'https://www.arrl.org/club-grant-program',
      lastVerifiedAt: '2026-01-05T00:00:00.000Z',
      verificationMethod: 'manual_curation',
      contentHash: 'd1b2c3',
      disputed: {
        note: 'Three researchers reached three different conclusions.',
        claims: [
          { claim: 'Dormant. The page shows only 2024 results.', sourceUrl: 'https://www.arrl.org/club-grant-program' },
          { claim: 'An autumn window, historically Sep 7 - Nov 4 2022.', sourceUrl: 'https://www.arrl.org/club-grant-program' },
          {
            claim: 'Feb, Jun and Oct — probably a conflation with Amateur Radio Grants.',
            sourceUrl: 'http://www.arrl.org/amateur-radio-grants',
          },
        ],
      },
      staleMirrorWarning: 'Still listed by 7 or more third-party aggregators.',
    },
    rawOtherText: 'The application portal is a JavaScript single-page app and returns no server-side text.',
    tags: ['grant', 'arrl'],
  },
  funder: { id: 'arrl-foundation', name: 'ARRL Foundation', homepage: '' },
  cycles: [] as Cycle[],
  provenance: [
    {
      fieldPath: 'amount.amountRaw',
      sourceId: 'arrl-club-grant-page',
      snapshotId: 'snap-11',
      rawLabel: 'Award Amount',
      rawValue: '$1,000 to $25,000',
      fetchedAt: '2026-01-05T00:00:00.000Z',
      sourceUrl: 'https://www.arrl.org/club-grant-program',
    },
    {
      // Task 10's verify path records provenance with no snapshot and, for a hand-curated
      // record, no page. It must be visible and LABELLED, never quietly authoritative.
      fieldPath: 'deadline.note',
      sourceId: 'manual-tier-d',
      snapshotId: null,
      rawLabel: 'Deadline',
      rawValue: 'Not published',
      fetchedAt: '2026-01-05T00:00:00.000Z',
      sourceUrl: null,
    },
  ],
  verdict: { kind: 'unknown', missingProfileFields: ['arrlAffiliated'] },
  watched: false,
  deadlineOwner: null,
};

const QCWA_DETAIL = {
  ...CLUB_GRANT_DETAIL,
  program: {
    ...CLUB_GRANT_DETAIL.program,
    id: 'qcwa-memorial-scholarship',
    name: 'QCWA Memorial Scholarship Fund',
    trust: {
      ...CLUB_GRANT_DETAIL.program.trust,
      lastVerifiedAt: '2026-08-02T00:00:00.000Z',
      status: 'open',
      disputed: undefined,
      staleMirrorWarning: undefined,
    },
  },
  deadlineOwner: {
    programId: 'arrl-foundation-scholarship',
    programName: 'ARRL Foundation Scholarship Program',
  },
};

/**
 * The ARRL's published "closes 28 February 2027" is stored as the UTC instant of 23:59 in
 * America/New_York, i.e. `2027-03-01T04:59:00.000Z`. Rendered in UTC it prints 2027-03-01 —
 * one day LATE, which is the dangerous direction.
 */
const CYCLES_DETAIL = {
  ...CLUB_GRANT_DETAIL,
  cycles: [
    {
      id: 'cycle-published',
      programId: 'arrl-club-grant',
      opensAt: '2027-02-01T05:00:00.000Z',
      closesAt: '2027-03-01T04:59:00.000Z',
      timezone: 'America/New_York',
      label: 'Winter 2027 window',
      isEstimated: false,
    },
    {
      id: 'cycle-projected',
      programId: 'arrl-club-grant',
      closesAt: '2028-03-01T04:59:00.000Z',
      timezone: 'America/New_York',
      label: 'Winter 2028 window',
      isEstimated: true,
    },
  ] satisfies Cycle[],
};

/** The Tier-D safety record. Its apply URL points at a host the fetcher hard-blocks. */
const FAR_DETAIL = {
  ...CLUB_GRANT_DETAIL,
  program: {
    ...CLUB_GRANT_DETAIL.program,
    id: 'far-compromised',
    name: 'Foundation for Amateur Radio (FAR) — domain compromised, do not apply',
    applyUrl: 'https://www.farweb.org/scholarships',
    trust: {
      ...CLUB_GRANT_DETAIL.program.trust,
      status: 'discontinued',
      disputed: undefined,
      staleMirrorWarning: undefined,
    },
  },
};

function detailWithObligations(obligations: Obligations): typeof CLUB_GRANT_DETAIL {
  return { ...CLUB_GRANT_DETAIL, program: { ...CLUB_GRANT_DETAIL.program, obligations } };
}

function stubFetch(get: unknown, post?: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
    const isWrite = init?.method === 'POST' || init?.method === 'DELETE';
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => (isWrite ? (post ?? {}) : get),
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderDetail(id = 'arrl-club-grant'): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[`/o/${id}`]}>
      <Routes>
        <Route path="/o/:programId" element={<Opportunity now="2026-08-02T12:00:00.000Z" />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  stubFetch(CLUB_GRANT_DETAIL);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Opportunity detail', () => {
  it('renders the program name and its funder', async () => {
    renderDetail();
    expect(await screen.findByRole('heading', { name: 'ARRL Club Grant Program' })).toBeInTheDocument();
    expect(screen.getByText('ARRL Foundation')).toBeInTheDocument();
  });

  it('renders status unknown as a labelled state', async () => {
    renderDetail();
    expect(await screen.findByLabelText('Status: unknown')).toBeInTheDocument();
  });

  it('renders the amber unverified badge', async () => {
    renderDetail();
    expect(await screen.findByLabelText(/unverified/i)).toBeInTheDocument();
  });

  it('shows EVERY disputed claim with its own source link, picking none', async () => {
    renderDetail();
    const panel = await screen.findByRole('region', { name: /disputed/i });
    const items = within(panel).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(within(items[2]!).getByRole('link')).toHaveAttribute(
      'href',
      'http://www.arrl.org/amateur-radio-grants',
    );
  });

  it('shows the stale-mirror warning', async () => {
    renderDetail();
    expect(await screen.findByText(/7 or more third-party aggregators/)).toBeInTheDocument();
  });

  it('lists funding restrictions verbatim', async () => {
    renderDetail();
    expect(await screen.findByText('No emergency communications equipment.')).toBeInTheDocument();
    expect(screen.getByText('No ongoing operating expenses.')).toBeInTheDocument();
  });

  it('shows the obligations applicants miss, including the indirect cost cap', async () => {
    renderDetail();
    expect(await screen.findByText(/open-source \/ open-access/)).toBeInTheDocument();
    expect(screen.getByText(/20%/)).toBeInTheDocument();
  });

  it('shows rawOtherText verbatim in its own block', async () => {
    renderDetail();
    const block = await screen.findByRole('region', { name: /unstructured requirements/i });
    expect(block).toHaveTextContent('JavaScript single-page app');
  });

  it('quotes the AI policy with its source URL', async () => {
    renderDetail();
    const region = await screen.findByRole('region', { name: /ai policy/i });
    expect(
      within(region).getByText(/thoroughly edit for clarity, brevity, and accuracy/),
    ).toBeInTheDocument();
    expect(within(region).getByRole('link')).toHaveAttribute(
      'href',
      'https://www.ardc.net/apply/grant-application-instructions/',
    );
  });

  /**
   * Plan 4 owns `Copy AI Prompt — includes AI-detection avoidance`. Plan 3 renders the block it
   * lands beside and NOTHING else, so an early button cannot ship under a plan that never
   * reviewed its copy.
   */
  it('renders no AI prompt button — that is Plan 4', async () => {
    renderDetail();
    await screen.findByRole('region', { name: /ai policy/i });
    expect(screen.queryByRole('button', { name: /copy ai prompt/i })).not.toBeInTheDocument();
  });

  it('renders field-level provenance: source, fetch and the raw text', async () => {
    renderDetail();
    const table = await screen.findByRole('table', { name: /provenance/i });
    expect(within(table).getByText('Award Amount')).toBeInTheDocument();
    expect(within(table).getByText('$1,000 to $25,000')).toBeInTheDocument();
    expect(within(table).getByText('arrl-club-grant-page')).toBeInTheDocument();
    expect(within(table).getByText('snap-11')).toBeInTheDocument();
  });

  it('links a provenance row to the page it was read off', async () => {
    renderDetail();
    const table = await screen.findByRole('table', { name: /provenance/i });
    expect(
      within(table).getByRole('link', { name: 'https://www.arrl.org/club-grant-program' }),
    ).toBeInTheDocument();
  });

  it('labels a provenance row that cannot be traced to a page', async () => {
    renderDetail();
    const table = await screen.findByRole('table', { name: /provenance/i });
    expect(within(table).getByText(/not traceable/i)).toBeInTheDocument();
  });

  /**
   * Nothing writes field provenance until a "Verify now" runs, so `provenance` is `[]` for all
   * 150 published programmes today. An empty table would say "we checked and there is none".
   */
  it('says there is no captured provenance rather than rendering an empty table', async () => {
    stubFetch({ ...CLUB_GRANT_DETAIL, provenance: [] });
    renderDetail();
    expect(await screen.findByText(/no captured provenance/i)).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: /provenance/i })).not.toBeInTheDocument();
  });

  it('names the program a deadline was inherited from', async () => {
    stubFetch(QCWA_DETAIL);
    renderDetail('qcwa-memorial-scholarship');
    const link = await screen.findByRole('link', { name: /ARRL Foundation Scholarship Program/ });
    expect(link).toHaveAttribute('href', '/o/arrl-foundation-scholarship');
    expect(screen.getByText(/inherits its deadline from/i)).toBeInTheDocument();
  });

  it('verifies on demand and shows the diff', async () => {
    stubFetch(CLUB_GRANT_DETAIL, {
      programId: 'arrl-club-grant',
      attemptedAt: '2026-08-02T12:00:00.000Z',
      ok: true,
      changed: true,
      diffs: [{ label: 'Deadline', before: 'January 31', after: 'December 30, 12:00 PM EST' }],
      lastVerifiedAt: '2026-08-02T12:00:00.000Z',
      changeEventIds: ['ce-1'],
    });
    renderDetail();
    await userEvent.click(await screen.findByRole('button', { name: /verify now/i }));
    const diff = await screen.findByRole('region', { name: /verification result/i });
    expect(within(diff).getByText('January 31')).toBeInTheDocument();
    expect(within(diff).getByText('December 30, 12:00 PM EST')).toBeInTheDocument();
  });

  it('says plainly when a verification found no change', async () => {
    stubFetch(CLUB_GRANT_DETAIL, {
      programId: 'arrl-club-grant',
      attemptedAt: '2026-08-02T12:00:00.000Z',
      ok: true,
      changed: false,
      diffs: [],
      lastVerifiedAt: '2026-08-02T12:00:00.000Z',
      changeEventIds: [],
    });
    renderDetail();
    await userEvent.click(await screen.findByRole('button', { name: /verify now/i }));
    expect(await screen.findByText(/the source still says the same thing/i)).toBeInTheDocument();
  });

  it('explains a rate limit instead of failing silently', async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.resolve({
          ok: false,
          status: 429,
          json: async () => ({
            error: {
              code: 'rate_limited',
              message: 'You have verified this recently.',
              details: { reason: 'program_cooldown', retryAfterSec: 1800 },
            },
            requestId: 'req-test-1',
          }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => CLUB_GRANT_DETAIL });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderDetail();
    await userEvent.click(await screen.findByRole('button', { name: /verify now/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/already verified this recently/i);
  });

  it('stars and unstars the program', async () => {
    const fetchMock = stubFetch(CLUB_GRANT_DETAIL);
    renderDetail();
    const star = await screen.findByRole('button', { name: /watch this program/i });
    await userEvent.click(star);
    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(
        (c) => (c[1] as RequestInit | undefined)?.method === 'POST',
      );
      expect(calls.some((c) => (c[0] as string) === '/api/watches')).toBe(true);
    });
    expect(await screen.findByRole('button', { name: /stop watching this program/i })).toBeInTheDocument();
  });

  /**
   * A correct exclusion is not a fixable gap — geography alone accounts for 36 of the exclusions
   * for a licensed EE undergraduate, and every one of those awards really is Division, Section or
   * state restricted. What the reader needs is the funder's own sentence, which is Task 18's
   * drawer; a second, differently-worded explainer on this page would be one more thing to keep
   * true.
   */
  it("quotes the funder's own constraint wording for an ineligible verdict", async () => {
    stubFetch({
      ...CLUB_GRANT_DETAIL,
      verdict: {
        kind: 'ineligible',
        reasons: [
          {
            id: 'c-geo',
            hard: true,
            fallbackRank: 0,
            rawText: 'Applicants must reside in the ARRL Dakota Division.',
            spec: { axis: 'geography', geo: { type: 'arrl_division', values: ['Dakota'] } },
          },
        ],
      },
    });
    renderDetail();
    expect(
      await screen.findByText('Applicants must reside in the ARRL Dakota Division.'),
    ).toBeInTheDocument();
  });

  it('links out to the funder rather than proxying the application', async () => {
    renderDetail();
    const apply = await screen.findByRole('link', { name: /apply at the funder/i });
    expect(apply).toHaveAttribute('href', 'https://www.arrl.org/club-grant-program');
    expect(apply).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });
});

/**
 * CONTRACT §3 amendment 7. `costShareRequired` reads unstated on 148 of the 150 published records
 * and `false` on ZERO of them: no funder in this corpus has ever written down that cost sharing
 * is not required. Collapsing absence into "Not required" publishes 148 claims nobody made, and
 * a cost-share requirement discovered late is what makes an award unusable to a club with no
 * matching funds.
 */
describe('Opportunity detail — the three obligation states', () => {
  it('renders a stated requirement as required', async () => {
    stubFetch(detailWithObligations({ ...OBLIGATIONS_UNSTATED, costShareRequired: true }));
    renderDetail();
    expect(await screen.findByText(/^Required\./)).toBeInTheDocument();
  });

  it('renders a stated exemption as the funder saying so', async () => {
    stubFetch(detailWithObligations({ ...OBLIGATIONS_UNSTATED, costShareRequired: false }));
    renderDetail();
    expect(await screen.findByText(/the funder states that cost sharing is not required/i)).toBeInTheDocument();
  });

  it('never renders an unstated obligation as "not required"', async () => {
    renderDetail();
    const obligations = await screen.findByRole('region', { name: /obligations/i });
    // Both tri-state flags are absent in this record, as they are in 148 of 150.
    expect(within(obligations).getAllByText(/^Not stated\./)).toHaveLength(2);
    expect(screen.queryByText(/not required/i)).not.toBeInTheDocument();
  });

  it('says what an unstated obligation actually means, and that it is not a no', async () => {
    renderDetail();
    const obligations = await screen.findByRole('region', { name: /obligations/i });
    expect(within(obligations).getByText(/no page this pipeline has fetched/i)).toBeInTheDocument();
  });

  it('applies the same three states to the co-funding preference', async () => {
    stubFetch(detailWithObligations({ ...OBLIGATIONS_UNSTATED, coFunderPreference: true }));
    renderDetail();
    expect(await screen.findByText(/prefers not to be the sole funder/i)).toBeInTheDocument();
  });
});

/**
 * Deadlines are UTC instants of a LOCAL 23:59 wall time, and only 4 of the corpus's 243 cycles
 * are windows a funder actually published. Both facts are silent failures if the UI drops them.
 */
describe('Opportunity detail — cycles', () => {
  it("renders a close date in the funder's own calendar day, not UTC", async () => {
    stubFetch(CYCLES_DETAIL);
    renderDetail();
    // 2027-03-01T04:59Z is 2027-02-28 23:59 in America/New_York. UTC would print 2027-03-01
    // and hand the applicant a day they do not have.
    expect(await screen.findByText('2027-02-28')).toBeInTheDocument();
    expect(screen.queryByText('2027-03-01')).not.toBeInTheDocument();
  });

  it('distinguishes a funder-published window from a projection', async () => {
    stubFetch(CYCLES_DETAIL);
    renderDetail();
    expect(await screen.findByText(/published by the funder/i)).toBeInTheDocument();
    expect(screen.getByText(/projected, not observed/i)).toBeInTheDocument();
  });

  it('names the timezone a deadline is expressed in', async () => {
    stubFetch(CYCLES_DETAIL);
    renderDetail();
    expect((await screen.findAllByText(/America\/New_York/)).length).toBeGreaterThan(0);
  });
});

/**
 * Domain fact 4. farweb.org was taken over between 2025-10-17 and 2026-02-10 and now 301s to an
 * Indonesian gambling site, while QCWA, ARRL and club pages still say "apply at the FAR website".
 * The record exists to INTERCEPT that instruction, so the one thing it must never do is offer
 * the link.
 */
describe('Opportunity detail — a blocklisted host is never a link', () => {
  it('refuses to render an apply link to a blocked host', async () => {
    stubFetch(FAR_DETAIL);
    renderDetail('far-compromised');
    await screen.findByRole('heading', { name: /domain compromised/i });
    expect(screen.queryByRole('link', { name: /apply at the funder/i })).not.toBeInTheDocument();
    for (const link of screen.queryAllByRole('link')) {
      expect(link.getAttribute('href') ?? '').not.toMatch(/farweb\.org/i);
    }
  });

  it('says why the link is withheld instead of silently dropping it', async () => {
    stubFetch(FAR_DETAIL);
    renderDetail('far-compromised');
    const warning = await screen.findByRole('alert');
    expect(warning).toHaveTextContent(/farweb\.org/i);
    expect(warning).toHaveTextContent(/do not visit/i);
  });
});

/**
 * A blocked host answers `POST /verify` with HTTP 200 and `ok: false`, carrying the fetcher's own
 * sentence. That is an explanation, not a fault: nothing was refetched, so the record is exactly
 * as stale as it was and the freshness badge must stay amber.
 */
describe('Opportunity detail — a refused fetch', () => {
  const REFUSED = {
    programId: 'arrl-club-grant',
    attemptedAt: '2026-08-02T12:00:00.000Z',
    ok: false,
    error:
      'Blocked host: farweb.org (https://www.farweb.org/scholarships). This host is listed in ' +
      'packages/server/src/fetcher/blocklist.ts and cannot be enabled by configuration.',
    changed: false,
    diffs: [],
    lastVerifiedAt: '2026-01-05T00:00:00.000Z',
    changeEventIds: [],
  };

  it("surfaces the fetcher's own sentence as an explanation", async () => {
    stubFetch(CLUB_GRANT_DETAIL, REFUSED);
    renderDetail();
    await userEvent.click(await screen.findByRole('button', { name: /verify now/i }));
    const region = await screen.findByRole('region', { name: /verification result/i });
    expect(region).toHaveTextContent(/nothing was refetched/i);
    expect(region).toHaveTextContent(/Blocked host: farweb\.org/);
  });

  it('leaves the record amber, because nothing re-checked it', async () => {
    stubFetch(CLUB_GRANT_DETAIL, REFUSED);
    renderDetail();
    await userEvent.click(await screen.findByRole('button', { name: /verify now/i }));
    await screen.findByRole('region', { name: /verification result/i });
    expect(screen.getByLabelText(/unverified/i)).toBeInTheDocument();
  });

  it('never turns the blocked host in that sentence into a link', async () => {
    stubFetch(CLUB_GRANT_DETAIL, REFUSED);
    renderDetail();
    await userEvent.click(await screen.findByRole('button', { name: /verify now/i }));
    await screen.findByRole('region', { name: /verification result/i });
    for (const link of screen.queryAllByRole('link')) {
      expect(link.getAttribute('href') ?? '').not.toMatch(/farweb\.org/i);
    }
  });
});
