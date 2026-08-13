import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Cycle, Obligations } from '@grantspotter/core';
import { Opportunity } from './Opportunity.js';
import { INSTRUMENT_LABELS } from '../lib/filterState.js';

/**
 * The detail page is where spec §8's honesty surfaces all land at once, so most of what is
 * asserted below is a claim about what the product REFUSES to say:
 *
 *  - an obligation nobody stated never renders as "not required" (148 of 150 records),
 *  - an empty provenance list never renders as an empty table (all 150 records today),
 *  - a projected cycle never renders as a funder-published one (all but a handful of them: the
 *    shipping `data/seed/` corpus declares 3 funder-published windows across 143 records),
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

  /**
   * CLOSE-OUT REVIEW RESIDUAL — I4's second paragraph. 147 of the 150 publishable records carry
   * `fundingRestrictions: []`, and the whole section used to vanish for them: no heading, no
   * sentence, nothing. That silence reads as "there are none" — an assertion no funder made —
   * the same inversion I4 closed for the four obligation rows that used to emit no row at all.
   */
  it('still shows the Funding restrictions heading, and says plainly none are recorded, rather than omitting the section', async () => {
    stubFetch({
      ...CLUB_GRANT_DETAIL,
      program: { ...CLUB_GRANT_DETAIL.program, fundingRestrictions: [] },
    });
    renderDetail();
    const section = await screen.findByRole('region', { name: /funding restrictions/i });
    expect(within(section).getByText(/no funding restrictions are recorded/i)).toBeInTheDocument();
    expect(within(section).queryByRole('list')).not.toBeInTheDocument();
  });

  it('shows the obligations applicants miss, including the indirect cost cap', async () => {
    renderDetail();
    expect(await screen.findByText(/open-source \/ open-access/)).toBeInTheDocument();
    expect(screen.getByText(/20%/)).toBeInTheDocument();
  });

  /**
   * The only path from finding an opportunity to writing for it. All three parameters are
   * load-bearing: `selectTemplates` picks the overlay whose frontmatter `programIds` contains
   * `programId` (or whose `funderId` matches) and narrows the components on `klass`, so a link
   * that drops one produces no error — just an empty "Funder overlays" group on the draft screen,
   * which is the funder-specific guidance the whole writing desk exists to show.
   */
  it('deep-links into a draft for this program, carrying programId, klass and funderId', async () => {
    renderDetail();
    const link = await screen.findByRole('link', { name: /start an application for this program/i });
    expect(link).toHaveAttribute(
      'href',
      '/applications?programId=arrl-club-grant&klass=ham_grant&funderId=arrl-foundation',
    );
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
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/already verified this programme recently/i);
    /*
      THE STUB ALREADY SENT `retryAfterSec: 1800` AND THIS TEST DID NOT READ IT (until 2026-08-12).
      The fixture was written with the number in it; the assertion stopped at the first clause; and
      `VerifyButton` printed "Try again in about an hour" over a wait the server had computed as
      thirty minutes. A fixture that carries a field no assertion looks at is the shape of every
      defect this round is about — see `components/VerifyButton.test.tsx` for the rest of them.
    */
    expect(alert).toHaveTextContent(/try again in 30 minutes\./i);
    expect(alert.textContent ?? '').not.toMatch(/about an hour|shortly/i);
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

  it('offers a print / save-as-PDF control for the brief', async () => {
    renderDetail();
    expect(await screen.findByRole('button', { name: 'Print brief' })).toBeInTheDocument();
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
    // Both tri-state flags are absent in this record, as they are in 148 of 150; sustainment and
    // reporting are absent too, and after I3 they say so rather than vanishing.
    expect(within(obligations).getAllByText(/^Not stated\./)).toHaveLength(4);
    expect(screen.queryByText(/not required/i)).not.toBeInTheDocument();
  });

  it('says what an unstated obligation actually means, and that it is not a no', async () => {
    renderDetail();
    const obligations = await screen.findByRole('region', { name: /obligations/i });
    expect(within(obligations).getAllByText(/no page this pipeline has fetched/i).length).toBeGreaterThan(0);
  });

  it('applies the same three states to the co-funding preference', async () => {
    stubFetch(detailWithObligations({ ...OBLIGATIONS_UNSTATED, coFunderPreference: true }));
    renderDetail();
    expect(await screen.findByText(/prefers not to be the sole funder/i)).toBeInTheDocument();
  });
});

/**
 * CLOSE-OUT REVIEW I4 — SIX ROWS, OR THE TWO THAT SPEAK MAKE THE FOUR THAT DO NOT LOOK SETTLED.
 *
 * `licenseObligation`, `indirectCostCapPct`, `sustainmentObligation` and `reportingObligation`
 * were each wrapped in `{value !== undefined && …}`, so an unstated value emitted no row at all —
 * inside the same `<dl>` as "Cost share: Not stated". A reader who sees one field say "Not stated"
 * and no Reporting row at all reads the absent row as "no reporting obligation": absence of
 * evidence rendered as evidence of absence, which is the exact inversion the CONTRACT §3
 * amendment was written to stop, and the file's own rule at `orNotStated` ("Never an empty cell")
 * already said so.
 *
 * Measured over the 150 publishable records: `sustainmentObligation` is unstated on 150,
 * `licenseObligation` on 149, `indirectCostCapPct` on 149 and `reportingObligation` on 149 — 597
 * rows that rendered as silence, on every one of the 150 records.
 */
describe('Opportunity detail — all six obligations, always', () => {
  const NOTHING_STATED: Obligations = {};

  it('renders six labelled rows even when the funder stated none of them', async () => {
    stubFetch(detailWithObligations(NOTHING_STATED));
    renderDetail();
    const obligations = await screen.findByRole('region', { name: /obligations/i });
    expect(within(obligations).getAllByRole('term').map((t) => t.textContent)).toEqual([
      'Licensing',
      'Indirect cost cap',
      'Cost share',
      'Co-funding',
      'Sustainment',
      'Reporting',
    ]);
    expect(within(obligations).getAllByRole('definition')).toHaveLength(6);
    expect(within(obligations).getAllByText(/^Not stated\./)).toHaveLength(6);
  });

  it('never leaves an obligation cell empty', async () => {
    stubFetch(detailWithObligations(NOTHING_STATED));
    renderDetail();
    const obligations = await screen.findByRole('region', { name: /obligations/i });
    for (const dd of within(obligations).getAllByRole('definition')) {
      expect((dd.textContent ?? '').trim()).not.toBe('');
    }
  });

  it('reads an unstated prose obligation as a question, never as an absence of one', async () => {
    stubFetch(detailWithObligations(NOTHING_STATED));
    renderDetail();
    const obligations = await screen.findByRole('region', { name: /obligations/i });
    const reporting = within(obligations)
      .getAllByRole('definition')
      .at(5);
    expect(reporting).toHaveTextContent(/^Not stated\./);
    // It may WARN against assuming there is none. It may never assert it.
    expect(reporting).not.toHaveTextContent(/no reporting obligation/i);
    expect(reporting).not.toHaveTextContent(/not required/i);
    expect(reporting).toHaveTextContent(/ask/i);
  });

  it('still prints a stated obligation verbatim, in its own row', async () => {
    stubFetch(
      detailWithObligations({
        licenseObligation: 'All output must be open-source / open-access.',
        indirectCostCapPct: 20,
        sustainmentObligation: 'The repeater must stay on the air for three years.',
        reportingObligation: 'One written report within 12 months.',
      }),
    );
    renderDetail();
    const obligations = await screen.findByRole('region', { name: /obligations/i });
    expect(within(obligations).getByText(/open-source \/ open-access/)).toBeInTheDocument();
    expect(within(obligations).getByText(/20%/)).toBeInTheDocument();
    expect(within(obligations).getByText(/stay on the air for three years/)).toBeInTheDocument();
    expect(within(obligations).getByText(/One written report within 12 months\./)).toBeInTheDocument();
    // Only the two tri-state flags are unstated in this record.
    expect(within(obligations).getAllByText(/^Not stated\./)).toHaveLength(2);
  });

  /** An empty string is not a statement either. It used to render as a blank cell. */
  it('treats an empty prose obligation as unstated rather than as a blank cell', async () => {
    stubFetch(detailWithObligations({ reportingObligation: '   ' }));
    renderDetail();
    const obligations = await screen.findByRole('region', { name: /obligations/i });
    expect(within(obligations).getAllByText(/^Not stated\./)).toHaveLength(6);
  });
});

/**
 * CLOSE-OUT REVIEW I6, ON THE PAGE. `matchProgram` no longer upgrades an unresolvable axis to
 * `eligible`, so `{kind: 'unknown', missingProfileFields: []}` is now reachable — an organisation
 * against a county- or call-district-scoped geography, where the org editor has no matching input.
 * The panel used to end with "answering one of these", pointing at an empty list.
 */
describe('Opportunity detail — an unknown with nothing to fill in', () => {
  const UNANSWERABLE = {
    ...CLUB_GRANT_DETAIL,
    verdict: { kind: 'unknown', missingProfileFields: [] as string[] },
  };

  it('says there is nothing to answer, rather than pointing at an empty list', async () => {
    stubFetch(UNANSWERABLE);
    renderDetail();
    const panel = await screen.findByRole('region', { name: /why this verdict is unknown/i });
    expect(within(panel).queryByRole('listitem')).not.toBeInTheDocument();
    expect(panel).toHaveTextContent(/nothing you can enter here would settle this one/i);
    expect(panel).not.toHaveTextContent(/answering one of these/i);
  });

  it('still refuses to read as a no', async () => {
    stubFetch(UNANSWERABLE);
    renderDetail();
    const panel = await screen.findByRole('region', { name: /why this verdict is unknown/i });
    expect(panel).toHaveTextContent(/is not a “no”|is not a "no"|not a .no./i);
  });

  /**
   * AND THE PANEL'S OWN LEDE MUST AGREE WITH IT.
   *
   * The two tests above read the SECOND paragraph and never the first, and the first was
   * unconditional: "Something this program asks for could not be answered from your profile, so
   * the matcher stopped rather than ruling you out — an unset field yields unknown, never
   * ineligible." On this branch every clause of that is wrong. Nothing the program asks for is at
   * issue (the commonest cause, 19 of the 20 unanswerable records in the shipped corpus, is a
   * record that asks NOTHING because nobody ever wrote down who may apply); the profile is not
   * where the gap is; and no field was left unset. The panel then contradicted itself two
   * paragraphs later with "Nothing you can enter here would settle this one", and both tests
   * passed on the half that was true.
   *
   * MEASURED: 20 of a licensed EE undergraduate's 27 unknown verdicts take this branch
   * (`e2e/api.spec.ts` names all twenty). It is the majority case on this page, not the corner.
   *
   * `VerdictBadge`'s title for the identical state was corrected in the same commit that created
   * the 19 — "This program’s record is missing something GrantSpotter needs to decide it, and
   * there is no field you could fill in that would change that." The badge and the panel sit on
   * this page together; they may not disagree about whose gap it is.
   */
  it('never tells the reader their profile is the gap, in any paragraph of the panel', async () => {
    stubFetch(UNANSWERABLE);
    renderDetail();
    const panel = await screen.findByRole('region', { name: /why this verdict is unknown/i });
    const text = panel.textContent ?? '';

    expect(text, 'the unanswerable panel blames the reader’s profile').not.toMatch(
      /(?:answered|evaluated|worked out|settled)\s+from your profile\b/i,
    );
    // "an unset field yields unknown" is a true sentence about the matcher and a false
    // explanation of THIS verdict: no field was left unset.
    expect(text, 'the panel explains this verdict as an unset field').not.toMatch(/unset field/i);
    // What it must say instead: there is nothing here for the reader to do.
    expect(text).toMatch(/nothing you can enter here would settle this one/i);
    expect(text).toMatch(/not a .no./i);
  });

  /**
   * The other half of the same rule, and the reason the test above is not simply a ban on a
   * phrase: on the ANSWERABLE branch that sentence is exactly right, and must survive.
   */
  /**
   * THE THIRD CAUSE, AND THE ONLY ONE A READER CAN ACT ON.
   *
   * `ConstraintAlternatives.orUnrepresented` holds a route the funder named that this schema
   * cannot describe. The Robert A. Rodriguez K5AUW Scholarship is the plainest: "open to
   * graduating high school seniors, AND TO PREVIOUS AWARDEES" — not a `Stage`, not a
   * `DegreeLevel`, not any field `StudentProfile` holds. The matcher declines to decide rather than
   * refuse, which is right, and until now the reason never reached a reader: the panel said
   * "Nothing you can enter here would settle this one" and stopped.
   *
   * BOTH CLAUSES OF THAT SENTENCE ARE FALSE HERE, which is why this is its own branch rather than
   * a paragraph appended to the old one. The record is complete and the funder's sentence is on
   * file, so it is not a hole in GrantSpotter's record; and on the 49 field-of-study cases the
   * applicant's own `fieldOfStudy` is exactly what nobody can adjudicate, so "nothing you can
   * enter" is worse than vague. Measured over the shipped corpus with `scripts/profile-corpus.ts`:
   * 51 constraints across 51 of the 150 publishable programmes, of which 20 reach the graduate
   * music student as an unknown with nothing to fill in.
   */
  const RODRIGUEZ_RAW =
    'The scholarship is open to graduating high school seniors, and to previous awardees.';
  const UNCHECKABLE = {
    ...CLUB_GRANT_DETAIL,
    program: {
      ...CLUB_GRANT_DETAIL.program,
      constraints: [
        {
          id: 'c-stage',
          hard: true,
          fallbackRank: 0,
          rawText: RODRIGUEZ_RAW,
          spec: { axis: 'age_stage', stages: ['HS_SENIOR'], orUnrepresented: 'previous awardees' },
        },
      ],
    },
    verdict: { kind: 'unknown', missingProfileFields: [] as string[] },
  };

  it('names the route it could not check, instead of leaving the obstacle unnamed', async () => {
    stubFetch(UNCHECKABLE);
    renderDetail();
    const panel = await screen.findByRole('region', { name: /why this verdict is unknown/i });
    const text = panel.textContent ?? '';
    expect(text).toMatch(
      /This funder named a way of qualifying that GrantSpotter cannot check, so the matcher declined to decide rather than rule you out\. Nothing on your profile was left blank; the judging is the part no rule here can do\./,
    );
    expect(text).toMatch(/The route GrantSpotter cannot check here: previous awardees/);
    expect(text).toMatch(/not a .no./i);
  });

  /**
   * ...AND STOPS SAYING THE TWO THINGS THAT ARE NOT TRUE OF IT. "Nothing you can enter here would
   * settle this one" was written against a different cause and, kept here, would tell a music
   * major that their own subject is not the question — when it is exactly the question nobody can
   * decide. It is not softened; it is replaced by the branch that names what actually happened.
   */
  it('drops the "nothing you can enter" copy that was written for a different cause', async () => {
    stubFetch(UNCHECKABLE);
    renderDetail();
    const panel = await screen.findByRole('region', { name: /why this verdict is unknown/i });
    const text = panel.textContent ?? '';
    expect(text).not.toMatch(/nothing you can enter here/i);
    // ...and the LEDE stops saying it too. "There is no field on your profile that would settle
    // it" is true of a record nobody filled in and false of the 49 field-of-study records, where
    // a different value in the reader's own subject box would settle it perfectly well.
    expect(text).not.toMatch(/no field on your profile that would settle it/i);
    expect(
      text,
      'the panel blames the funder’s page for a limit of our own schema',
    ).toMatch(
      /This is not a gap in the funder’s page and not a gap in your profile — it is a route no rule here can test\. Read their own sentence below and judge for yourself whether it describes you\./,
    );
  });

  /**
   * WHOSE WORDS THEY ARE, ON A SCREEN WHERE BOTH KINDS APPEAR TOGETHER. The funder's sentence is
   * quoted verbatim in `.verbatim`, the box this page uses for text a funder published; every
   * sentence GrantSpotter composed sits outside it, under a tag naming its author. A reader has to
   * be able to tell, on one requirement, which of the two lines the funder actually wrote.
   */
  it('quotes the funder’s sentence and keeps its own words out of the quotation box', async () => {
    stubFetch(UNCHECKABLE);
    const { container } = renderDetail();
    await screen.findByRole('region', { name: /why this verdict is unknown/i });
    const quotes = [...container.querySelectorAll('.verbatim')].map((el) => el.textContent);
    expect(quotes).toContain(RODRIGUEZ_RAW);
    for (const quote of quotes) expect(quote).not.toMatch(/GrantSpotter/);
    const authored = [...container.querySelectorAll('.authored')].map((el) => el.textContent ?? '');
    expect(authored.some((t) => t.includes('previous awardees'))).toBe(true);
    expect(container.querySelectorAll('.authored-by').length).toBeGreaterThan(0);
  });

  it('does still name the profile when the profile really is what it is waiting on', async () => {
    stubFetch({
      ...CLUB_GRANT_DETAIL,
      verdict: { kind: 'unknown', missingProfileFields: ['arrlAffiliated'] },
    });
    renderDetail();
    const panel = await screen.findByRole('region', { name: /why this verdict is unknown/i });
    const text = panel.textContent ?? '';
    expect(text).toMatch(/from your profile/i);
    expect(text).toMatch(/answering one of these/i);
    expect(text).not.toMatch(/nothing you can enter here/i);
  });
});

/**
 * WHAT AN `eligible` VERDICT SHOWS ITS READER.
 *
 * This page read `program.constraints` in exactly two places — the `orUnrepresented` panel and
 * `IneligibilityDrawer` — and both are reachable only from a verdict that is not `eligible`.
 * `ProgramTable` reads `reason.rawText`, which is ineligible-only too. So a reader told YES saw no
 * funder requirement sentence anywhere: `rawOtherText` carried some of it on some records and
 * nothing on the rest (measured over the 26 records of the toothless-institution class, 15 and 11
 * respectively — that class has since been closed at the extractor and the count is now zero, which
 * changes nothing here: the reader told YES still saw no funder sentence on ANY record), and the
 * full hard-constraint list lived only in `requirementsChecklistMarkdown` inside the
 * application-packet ZIP — downloadable after the decision to apply has already been made.
 *
 * That reader is about to spend an application fee, transcript fees and three recommendation
 * letters. An `ineligible` verdict gets a drawer quoting every constraint that refused it; an
 * `eligible` one got a badge.
 *
 * MEASURED, for the size of what this adds: over the 150 publishable records at
 * `scripts/profile-corpus.ts`'s fixed 2026-08-02 clock, the licensed EE undergraduate's 43
 * `eligible` and 9 `eligible_preferred` records carry a median of 4 hard constraints (max 7,
 * median `rawText` 38 characters) and 0–3 preferences. It renders on a single programme's record
 * page and never in the browse table, where a reader eligible for 43 programmes actually is.
 */
describe('Opportunity detail — what an eligible verdict shows', () => {
  const GPA_RAW = 'GPA of 3.0 or better, on a 4.0 scale.';
  const SCHOOL_RAW = '4-year college or university';
  const MEMBER_RAW = 'Must be an ARRL Member';
  const PREFERENCE_RAW = 'Preference to applicants demonstrating financial need.';

  const ELIGIBLE = {
    ...CLUB_GRANT_DETAIL,
    program: {
      ...CLUB_GRANT_DETAIL.program,
      constraints: [
        {
          id: 'c-gpa',
          hard: true,
          fallbackRank: 0,
          rawText: GPA_RAW,
          spec: { axis: 'gpa', min: 3 },
        },
        {
          id: 'c-institution',
          hard: true,
          fallbackRank: 0,
          rawText: SCHOOL_RAW,
          spec: {
            axis: 'institution',
            degreeLevels: ['BACH'],
            accreditationRequired: true,
            partTimeOK: false,
          },
        },
        {
          id: 'c-arrl',
          hard: true,
          fallbackRank: 0,
          rawText: MEMBER_RAW,
          spec: { axis: 'arrl_membership', minYears: 0 },
        },
        {
          id: 'c-need',
          hard: false,
          fallbackRank: 3,
          rawText: PREFERENCE_RAW,
          spec: { axis: 'financial_need' },
        },
      ],
    },
    verdict: { kind: 'eligible' },
  };

  async function findPanel(): Promise<HTMLElement> {
    return screen.findByRole('region', { name: /what this program requires/i });
  }

  it('shows every recorded requirement, in the funder’s own words', async () => {
    stubFetch(ELIGIBLE);
    renderDetail();
    const panel = await findPanel();
    for (const raw of [GPA_RAW, SCHOOL_RAW, MEMBER_RAW]) {
      expect(within(panel).getByText(raw)).toBeInTheDocument();
    }
  });

  /**
   * THE WHOLE POINT OF THE PANEL, AND WHY IT IS NOT A CHECKLIST OF TICKS.
   *
   * THE ORIGINAL REASON HAS BEEN FIXED, AND THE DECISION STANDS ON THE REST. This comment used to
   * read "for 26 records the eligible verdict was produced with a `hard: true` constraint reading
   * '4-year college or university' recorded and NOT satisfied". That class is closed: the extractor
   * now publishes a floor, `sentence-vs-spec.test.ts` measures the class at ZERO, and its allowlist
   * is empty. An argument left resting on evidence that no longer exists is how a good design
   * decision gets reverted by the next person who checks the evidence, so here is the standing one:
   *
   * A TICK WOULD CLAIM MORE THAN THIS SOFTWARE CHECKS, on every record and not just on a broken
   * class. `matcher.ts` records `tradeSchoolOK` as informational because CONTRACT §3 has no profile
   * field for it; a sentence naming where the SCHOOL must be ("…college or university in NC, VA,
   * WV, MD or TN") is read against where the APPLICANT lives; an `orUnrepresented` route is a
   * question the schema declined; an opened list answers `unknown` by design. Beside any of those,
   * "you meet this" is a sentence GrantSpotter cannot support. The list makes no claim about the
   * reader at all; the software's single claim — that nothing here refused this profile — is one
   * marked line at the top, and that claim is exactly what `matchProgram` computed.
   */
  it('claims nothing about the reader beside any individual requirement', async () => {
    stubFetch(ELIGIBLE);
    renderDetail();
    const panel = await findPanel();
    const items = within(panel).getAllByRole('listitem');
    expect(items).toHaveLength(4);
    for (const item of items) {
      expect(item.textContent ?? '').not.toMatch(/you meet|you satisfy|met|✓|passed/i);
    }
  });

  it('says what the verdict actually means, in GrantSpotter’s own voice', async () => {
    stubFetch(ELIGIBLE);
    renderDetail();
    const panel = await findPanel();
    const lede = panel.querySelector('.authored');
    expect(lede?.textContent ?? '').toMatch(/nothing recorded here refused your profile/i);
    expect(lede?.textContent ?? '').toMatch(/only the part of each sentence below that it can represent/i);
    expect(lede?.querySelector('.authored-by')?.textContent ?? '').toMatch(/not the funder/i);
  });

  /** `.verbatim` means "a funder published this". Nothing this software wrote may wear it. */
  it('keeps GrantSpotter’s own sentences out of the quotation blocks', async () => {
    stubFetch(ELIGIBLE);
    const { container } = renderDetail();
    await findPanel();
    const quotes = [...container.querySelectorAll('.verbatim')].map((el) => el.textContent ?? '');
    expect(quotes).toContain(GPA_RAW);
    for (const quote of quotes) expect(quote).not.toMatch(/GrantSpotter/);
  });

  /**
   * A preference is not a requirement, and a panel that ran the two together would tell a reader
   * that a funder's tie-breaker is a bar. Only `hard` constraints can reach `hardFailures` in
   * `matchProgram`, so the claim under the sub-heading is the matcher's own.
   */
  it('separates preferences from requirements and says what a preference does', async () => {
    stubFetch(ELIGIBLE);
    renderDetail();
    const panel = await findPanel();
    expect(within(panel).getByRole('heading', { name: /preferences/i })).toBeInTheDocument();
    expect(panel).toHaveTextContent(/cannot make you ineligible/i);
    expect(within(panel).getByText(PREFERENCE_RAW)).toBeInTheDocument();
  });

  /**
   * BUCKETED BY THE RECORD'S OWN `hard` FLAG. `matchProgram` forces `financial_need` soft whatever
   * the record says (spec §4.5 rule 11); a funder who wrote financial need down as a requirement
   * still gets their sentence rendered as one, because moving it under "these never exclude you"
   * would be this software overruling the funder in the one place built to reproduce them.
   */
  it('leaves a funder’s stated requirement where the funder put it', async () => {
    stubFetch({
      ...ELIGIBLE,
      program: {
        ...ELIGIBLE.program,
        constraints: [
          { id: 'c-need-hard', hard: true, fallbackRank: 0, rawText: PREFERENCE_RAW, spec: { axis: 'financial_need' } },
        ],
      },
    });
    renderDetail();
    const panel = await findPanel();
    expect(within(panel).getByText(PREFERENCE_RAW)).toBeInTheDocument();
    expect(within(panel).queryByRole('heading', { name: /preferences/i })).not.toBeInTheDocument();
  });

  /**
   * AN ELIGIBLE VERDICT OVER AN EMPTY LIST IS A VERDICT ABOUT NOTHING. `matchProgram` withdrew
   * `eligible` for a record with NO constraints at all — 28 of the 150 publishable records carry
   * none — but a record with preferences and no requirement still reaches here, and the panel must
   * not let a blank read as "you qualify". Nor as "the funder says there are none": this file's
   * standing rule, from `costShareRequired` and the four silent obligation rows.
   */
  it('says a record with no requirement checked nothing, rather than showing an empty box', async () => {
    stubFetch({
      ...ELIGIBLE,
      program: { ...ELIGIBLE.program, constraints: [] },
    });
    renderDetail();
    const panel = await findPanel();
    expect(panel).toHaveTextContent(/no requirement is recorded for this program/i);
    expect(panel).toHaveTextContent(/rests on an empty list/i);
    expect(panel).toHaveTextContent(/not the funder stating there are none/i);
    expect(within(panel).queryByRole('listitem')).not.toBeInTheDocument();
  });

  /**
   * A requirement with no funder sentence recorded is the one case `.verbatim` may not be used
   * for. No constraint in the shipped corpus is in that state — all 522 hard and all 127 soft
   * constraints across the 150 publishable records carry wording — which is why the branch is
   * written before the first one arrives rather than after.
   */
  it('never renders an empty quotation block for a requirement with no recorded wording', async () => {
    stubFetch({
      ...ELIGIBLE,
      program: {
        ...ELIGIBLE.program,
        constraints: [{ id: 'c-blank', hard: true, fallbackRank: 0, rawText: '', spec: { axis: 'other', note: '' } }],
      },
    });
    const { container } = renderDetail();
    const panel = await findPanel();
    for (const quote of container.querySelectorAll('.verbatim')) {
      expect((quote.textContent ?? '').trim()).not.toBe('');
    }
    expect(panel).toHaveTextContent(/no funder sentence was recorded for this one/i);
    // The tag rides on the ROW, not only on the panel's lede: a reader scanning the list has to be
    // told whose sentence this one is where the sentence is.
    const row = within(panel).getByRole('listitem');
    expect(row.querySelector('.authored-by')?.textContent ?? '').toMatch(/not the funder/i);
    expect(row.querySelector('.verbatim')).toBeNull();
  });

  it('shows the same requirements for a preferred verdict, which is the same yes', async () => {
    stubFetch({ ...ELIGIBLE, verdict: { kind: 'eligible_preferred', rank: 3, met: ['c-need'] } });
    renderDetail();
    const panel = await findPanel();
    expect(within(panel).getByText(SCHOOL_RAW)).toBeInTheDocument();
  });

  /**
   * NOT FOR THE OTHER TWO VERDICTS. An `ineligible` reader gets the drawer, which quotes the
   * constraints that refused them; repeating every other constraint underneath it doubles the page
   * for the one reader already told no. An `unknown` gets its own panel. Three panels, mutually
   * exclusive, in one place.
   */
  it('does not add a second constraint list to an ineligible or unknown verdict', async () => {
    const reasons = [ELIGIBLE.program.constraints[1]];
    stubFetch({ ...ELIGIBLE, verdict: { kind: 'ineligible', reasons } });
    const { unmount } = renderDetail();
    await screen.findByRole('region', { name: /why you are ineligible/i });
    expect(
      screen.queryByRole('region', { name: /what this program requires/i }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByText(SCHOOL_RAW)).toHaveLength(1);
    unmount();

    stubFetch({ ...ELIGIBLE, verdict: { kind: 'unknown', missingProfileFields: ['gpa'] } });
    renderDetail();
    await screen.findByRole('region', { name: /why this verdict is unknown/i });
    expect(
      screen.queryByRole('region', { name: /what this program requires/i }),
    ).not.toBeInTheDocument();
  });
});

/**
 * CLOSE-OUT REVIEW I5 — THE LATENT `javascript:` HREF.
 *
 * `blockedHostFor` returned `null` whenever `new URL()` threw and never checked the scheme, and
 * `programSchema.applyUrl` was a bare `z.string()`. All 703 stored apply URLs are http/https
 * today (591 https, 112 http, 0 unparseable), so this was latent — and an admin editing a
 * candidate through `POST /api/inbox/:id/decision` was all it took to stop being latent.
 */
describe('Opportunity detail — a non-http(s) apply URL is refused, not linked', () => {
  const withApplyUrl = (applyUrl: string): typeof CLUB_GRANT_DETAIL => ({
    ...CLUB_GRANT_DETAIL,
    program: { ...CLUB_GRANT_DETAIL.program, applyUrl },
  });

  it('renders no anchor at all for a javascript: URL', async () => {
    stubFetch(withApplyUrl('javascript:alert(document.cookie)'));
    renderDetail();
    await screen.findByRole('heading', { name: /ARRL Club Grant Program/ });
    expect(screen.queryByRole('link', { name: /apply at the funder/i })).not.toBeInTheDocument();
    for (const link of screen.queryAllByRole('link')) {
      expect(link.getAttribute('href') ?? '').not.toMatch(/^javascript:/i);
    }
    expect(document.querySelectorAll('a[href^="javascript:"]')).toHaveLength(0);
  });

  it('says the address was refused and why, instead of dropping it silently', async () => {
    stubFetch(withApplyUrl('javascript:alert(1)'));
    renderDetail();
    const alerts = await screen.findAllByRole('alert');
    const refusal = alerts.find((a) => /javascript:/i.test(a.textContent ?? ''));
    expect(refusal).toBeDefined();
    expect(refusal).toHaveTextContent(/http/i);
  });

  /** `new URL('//farweb.org/apply')` throws, so this reached the page as a live anchor before. */
  it('refuses a protocol-relative URL rather than letting the browser resolve it', async () => {
    stubFetch(withApplyUrl('//www.farweb.org/scholarships'));
    renderDetail();
    await screen.findByRole('heading', { name: /ARRL Club Grant Program/ });
    for (const link of screen.queryAllByRole('link')) {
      expect(link.getAttribute('href') ?? '').not.toMatch(/farweb\.org/i);
    }
  });

  it('still links an ordinary https apply URL', async () => {
    stubFetch(withApplyUrl('https://www.arrl.org/club-grant-program'));
    renderDetail();
    expect(await screen.findByRole('link', { name: /apply at the funder/i })).toHaveAttribute(
      'href',
      'https://www.arrl.org/club-grant-program',
    );
  });
});

/**
 * Deadlines are UTC instants of a LOCAL 23:59 wall time, and hardly any window here is one a
 * funder actually published — `data/seed/` declares 3 across 143 records, of which 2 still resolve
 * to a future cycle today. Both facts are silent failures if the UI drops them.
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

  /**
   * CLOSE-OUT REVIEW I3 — THE PAGE MAY NOT CLAIM A PROVENANCE CORE REFUSES TO CLAIM.
   *
   * `observedCycles` (`core/src/deadline.ts:598`) hard-codes `timezone: 'UTC'`, and its own
   * doc-comment says in terms that this is "that frame, not a claim about where the funder is".
   * The funder-published cycles are exactly the rows that carry it, so the old sentence — "the zone
   * the funder published them in" — stated the opposite of what core knows on the very rows the
   * whole published/projected distinction exists for. Measured over the FIXTURE corpus
   * (`scripts/profile-corpus.ts`, 150 publishable records at its fixed 2026-08-02 clock): 250
   * cycles resolve, 4 carry `UTC` (all four funder-published) and 246 carry a zone recorded with
   * the recurrence. `data/seed/`, the corpus a fresh install serves, is a different population;
   * neither arm below counts anything, so both hold on either.
   *
   * A recorded zone is also not a funder's claim — it is what this pipeline wrote down — so
   * neither arm may say "the funder published".
   */
  it('never says the funder published the zone, on either arm', async () => {
    stubFetch(CYCLES_DETAIL);
    renderDetail();
    await screen.findByText('2027-02-28');
    expect(screen.queryByText(/the zone the funder published/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/published them in/i)).not.toBeInTheDocument();
  });

  it('calls a recorded zone recorded, and says whose reading it is', async () => {
    stubFetch(CYCLES_DETAIL);
    renderDetail();
    const zones = await screen.findAllByText(/dates shown in America\/New_York/i);
    expect(zones.length).toBeGreaterThan(0);
    expect(zones[0]).toHaveTextContent(/recorded for this cycle/i);
    expect(zones[0]).not.toHaveTextContent(/no zone is recorded/i);
  });

  it('says UTC is a rendering frame, not a zone anyone recorded, on the corpus’s four', async () => {
    stubFetch({
      ...CYCLES_DETAIL,
      cycles: [
        {
          id: 'cycle-observed-utc',
          programId: 'arrl-club-grant',
          closesAt: '2026-09-30T23:59:59.999Z',
          // Exactly what `observedCycles` emits for a funder-published window.
          timezone: 'UTC',
          label: '30 September 2026 deadline',
          isEstimated: false,
        },
      ] satisfies Cycle[],
    });
    renderDetail();
    const zone = await screen.findByText(/dates shown in UTC/i);
    expect(zone).toHaveTextContent(/no zone is recorded for this cycle/i);
    expect(zone).toHaveTextContent(/not a claim about the funder/i);
    expect(zone).not.toHaveTextContent(/the funder published/i);
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

/**
 * NOTHING ON THIS PAGE IS AN IDENTIFIER OUT OF THE DATABASE.
 *
 * MEASURED on the deployed build, signed in as a member, before these tests existed: the record
 * page's Deadline panel read `Pattern: n_fixed_dates` and `Note: RECUR n_fixed_dates
 * tz=America/Los_Angeles dates=02-01,04-01,07-01,09-01 | …`; its Award panel read `Instrument:
 * cash_range`; its Source panel read `Method: live_fetch`; and its AI panel read `Stance:
 * unaddressed`. Four of the five were in `.data`, the monospaced class this product reserves for a
 * figure a reader copies — so they were not merely untranslated, they were presented as values.
 *
 * `Pattern` and `Instrument` are the sharp ones. Browse's facet list has rendered the SAME
 * `Instrument` enum as "Cash range" since Plan 3, and the calendar's undated list has rendered the
 * same `DeadlineKind` in words for as long: the app owned the translation and this screen — the one
 * a student reads before spending an application fee — did not use it.
 *
 * These tests render a state and read the words. Six of the seven would have failed against the
 * build that shipped.
 */
describe('Opportunity — every stored token reaches the reader as English', () => {
  const RECURRING = {
    ...CLUB_GRANT_DETAIL,
    program: {
      ...CLUB_GRANT_DETAIL.program,
      deadline: {
        kind: 'n_fixed_dates',
        source: { kind: 'self' },
        note:
          'RECUR n_fixed_dates tz=America/Los_Angeles dates=02-01,04-01,07-01,09-01 | ' +
          'Applications arriving after Sep 1 roll to the next Feb 1 cycle.',
      },
    },
  };

  /** The `<dd>` that follows the `<dt>` with this exact label. */
  function valueOf(label: string): string {
    const dt = screen.getAllByRole('term').find((t) => t.textContent?.trim() === label);
    expect(dt, `no <dt> reads "${label}"`).toBeDefined();
    return dt?.nextElementSibling?.textContent?.trim() ?? '';
  }

  it('says how a deadline repeats instead of printing its kind', async () => {
    stubFetch(RECURRING);
    renderDetail();
    await screen.findByRole('heading', { name: /ARRL Club Grant Program/ });
    expect(valueOf('Pattern')).toBe('Fixed dates each year');
    expect(screen.queryByText(/n_fixed_dates/)).not.toBeInTheDocument();
  });

  it('keeps the funder’s own note and drops the machine directive in front of it', async () => {
    stubFetch(RECURRING);
    renderDetail();
    await screen.findByRole('heading', { name: /ARRL Club Grant Program/ });
    expect(valueOf('Note')).toBe(
      'Applications arriving after Sep 1 roll to the next Feb 1 cycle.',
    );
    expect(screen.queryByText(/RECUR/)).not.toBeInTheDocument();
    expect(screen.queryByText(/dates=/)).not.toBeInTheDocument();
    expect(screen.queryByText(/tz=/)).not.toBeInTheDocument();
  });

  it('states the dates that directive encodes, in English, on its own row', async () => {
    stubFetch(RECURRING);
    renderDetail();
    await screen.findByRole('heading', { name: /ARRL Club Grant Program/ });
    expect(valueOf('Repeats')).toBe(
      'February 1, April 1, July 1, September 1 each year, closing at 23:59 America/Los_Angeles',
    );
  });

  /**
   * A DIRECTIVE THAT DOES NOT PARSE IS DROPPED, NOT GUESSED AT. `parseRecurrence` throws on an
   * unknown zone; a half-understood schedule rendered as though it were understood is the
   * plausible-looking fact this product exists not to publish. What survives is the kind — which
   * says how the deadline repeats without claiming to know when — and the funder's own sentence.
   */
  it('shows no schedule at all when the directive cannot be parsed', async () => {
    stubFetch({
      ...RECURRING,
      program: {
        ...RECURRING.program,
        deadline: {
          ...RECURRING.program.deadline,
          note: 'RECUR n_fixed_dates tz=Mars/Olympus dates=02-01 | Ask the funder.',
        },
      },
    });
    renderDetail();
    await screen.findByRole('heading', { name: /ARRL Club Grant Program/ });
    expect(screen.queryByText('Repeats')).not.toBeInTheDocument();
    expect(valueOf('Note')).toBe('Ask the funder.');
    expect(valueOf('Pattern')).toBe('Fixed dates each year');
  });

  /** A note that is ONLY a directive leaves the funder having said nothing — never a blank cell. */
  it('says the funder stated no note when the directive was the whole of it', async () => {
    stubFetch({
      ...RECURRING,
      program: {
        ...RECURRING.program,
        deadline: {
          ...RECURRING.program.deadline,
          note: 'RECUR n_fixed_dates tz=America/Los_Angeles dates=02-01',
        },
      },
    });
    renderDetail();
    await screen.findByRole('heading', { name: /ARRL Club Grant Program/ });
    expect(valueOf('Note')).toBe('Not stated on the page.');
  });

  it('names the award instrument the way the Browse facet beside it does', async () => {
    renderDetail();
    await screen.findByRole('heading', { name: /ARRL Club Grant Program/ });
    expect(valueOf('Instrument')).toBe(INSTRUMENT_LABELS.cash_range);
    expect(valueOf('Instrument')).toBe('Cash range');
    expect(screen.queryByText(/cash_range/)).not.toBeInTheDocument();
  });

  it('says where the record came from rather than naming a pipeline stage', async () => {
    renderDetail();
    await screen.findByRole('heading', { name: /ARRL Club Grant Program/ });
    expect(valueOf('Method')).toBe('Entered by hand from the funder’s page');
    expect(screen.queryByText(/manual_curation/)).not.toBeInTheDocument();
  });

  it('says the funder’s AI position in a sentence, never as a stance token', async () => {
    renderDetail();
    await screen.findByRole('heading', { name: /ARRL Club Grant Program/ });
    const panel = screen.getByLabelText('AI policy');
    expect(panel).toHaveTextContent('This funder permits applicants to use AI.');
    expect(panel).not.toHaveTextContent(/Stance:/);
    expect(panel).not.toHaveTextContent(/permitted_with_disclosure|unaddressed/);
  });

  /**
   * THE CONTRADICTION THIS BRANCH CLOSES. The "has not published a policy" paragraph was keyed on
   * whether a QUOTE existed, not on the stance, so a record that states a position with no
   * sentence recorded printed both "This funder permits applicants to use AI" and "This funder has
   * not published a policy on applicants using AI" on one card. The shipped corpus does not
   * produce that pair — 1 record `permitted` with a quote, 149 `unaddressed` with none — which is
   * exactly why it could sit here unseen; the schema makes `quote` optional on every stance.
   */
  it('does not tell a reader a funder published nothing when the funder took a position', async () => {
    stubFetch({
      ...CLUB_GRANT_DETAIL,
      program: {
        ...CLUB_GRANT_DETAIL.program,
        aiPolicy: { stance: 'prohibited' },
      },
    });
    renderDetail();
    await screen.findByRole('heading', { name: /ARRL Club Grant Program/ });
    const panel = screen.getByLabelText('AI policy');
    expect(panel).toHaveTextContent('This funder prohibits applicants from using AI.');
    expect(panel).not.toHaveTextContent(/has published no position|not published a policy/i);
    expect(panel).toHaveTextContent(/No sentence of the funder’s was recorded for this position/);
  });

  it('still says silence is not permission where the funder said nothing', async () => {
    stubFetch({
      ...CLUB_GRANT_DETAIL,
      program: { ...CLUB_GRANT_DETAIL.program, aiPolicy: { stance: 'unaddressed' } },
    });
    renderDetail();
    await screen.findByRole('heading', { name: /ARRL Club Grant Program/ });
    const panel = screen.getByLabelText('AI policy');
    expect(panel).toHaveTextContent(
      'This funder has published no position on applicants using AI.',
    );
    expect(panel).toHaveTextContent(/not permission and not a prohibition/);
  });

  /**
   * THE SWEEP, because the five rows above are the five that were found and the union has more
   * members than anybody checked one at a time. Any `snake_case` token in the rendered text is an
   * identifier that escaped a translation table.
   */
  it('renders no snake_case identifier anywhere on the page', async () => {
    stubFetch(RECURRING);
    const { container } = renderDetail();
    await screen.findByRole('heading', { name: /ARRL Club Grant Program/ });
    const text = container.textContent ?? '';
    // Not vacuous: this record renders every panel on the page, and an empty string would satisfy
    // the assertion below without looking at anything.
    expect(text.length).toBeGreaterThan(2000);
    // `[TODO: …]` markers and URLs are not on this page; a hash is hex. What is left is enums.
    const tokens = [...text.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)].map((m) => m[0]);
    expect(tokens).toEqual([]);
  });
});
