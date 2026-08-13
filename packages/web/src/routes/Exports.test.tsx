import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ExportsRoute } from './Exports.js';
import { ExportMenu } from '../components/ExportMenu.js';
import { EMPTY_FILTERS } from '../lib/filterState.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * A FILE, AS THE EXPORT ROUTES ACTUALLY SEND ONE: the stamped name in `Content-Disposition` and
 * the record count in the header `packages/server/src/api/exports.ts` sets. The count is what lets
 * this screen tell "matched nothing" from "worked", so a stub that omitted it would be testing a
 * server this product does not ship.
 */
function fileResponse(body: string, filename: string, rows: number, type = 'text/csv'): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': type,
      'content-disposition': `attachment; filename="${filename}"`,
      'x-grantspotter-rows': String(rows),
    },
  });
}

interface Routes {
  /** `GET /api/exports/ics-token`. Default: 404, i.e. no feed has been created. */
  icsToken?: () => Response;
  /** `POST /api/exports/ics-token` — minting a feed, which is a different answer from reading one. */
  createToken?: () => Response;
  /** `GET /api/profiles`. Default: a student profile exists. */
  profiles?: () => Response;
  /** Everything else — the export downloads — keyed by the URL that was requested. */
  download?: (url: string) => Response;
}

/**
 * ANSWERS BY URL, NEVER BY CALL ORDER.
 *
 * This screen makes two independent requests on mount (the calendar token and the profile probe)
 * and one per control pressed. A `mockResolvedValueOnce` chain encodes an ordering React does not
 * promise, and the failure it produces — `undefined` where a `Response` was expected — reads as a
 * bug in the component rather than as a stub that ran out.
 */
function stubFetch(routes: Routes = {}): void {
  vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/exports/ics-token')) {
      const method = init?.method ?? 'GET';
      if (method === 'POST') {
        return Promise.resolve(
          (routes.createToken ?? (() => jsonResponse({ url: 'http://127.0.0.1:3030/calendar/x.ics', token: 'x' })))(),
        );
      }
      return Promise.resolve(
        (routes.icsToken ?? (() => jsonResponse({ error: { code: 'not_found', message: 'none' } }, 404)))(),
      );
    }
    if (url.includes('/api/profiles')) {
      return Promise.resolve((routes.profiles ?? (() => jsonResponse({ student: { id: 's' }, organization: null })))());
    }
    if (routes.download !== undefined) return Promise.resolve(routes.download(url));
    throw new Error(`no stub for ${url}`);
  });
}

const NO_PROFILE_BODY = { student: null, organization: null };

describe('ExportMenu', () => {
  it('carries the current browse filters into every download link', () => {
    render(
      <MemoryRouter>
        <ExportMenu filters={{ ...EMPTY_FILTERS, q: 'club', klass: ['ham_grant'], entity: ['club_501c3'] }} />
      </MemoryRouter>,
    );
    const csv = screen.getByRole('link', { name: /csv/i });
    expect(csv).toHaveAttribute('href', expect.stringContaining('/api/exports/opportunities.csv?'));
    expect(csv.getAttribute('href')).toContain('q=club');
    expect(csv.getAttribute('href')).toContain('klass=ham_grant');
    expect(csv.getAttribute('href')).toContain('entity=club_501c3');
    expect(screen.getByRole('link', { name: /xlsx/i }).getAttribute('href')).toContain('opportunities.xlsx?');
  });

  it('says out loud that the download is the filtered view, not the whole corpus', () => {
    render(<MemoryRouter><ExportMenu filters={EMPTY_FILTERS} /></MemoryRouter>);
    expect(screen.getByText(/exports exactly what the filters above are showing/i)).toBeInTheDocument();
  });
});

describe('ExportsRoute', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  /**
   * FIVE BUTTONS AND ONE LINK, and which is which is the fix rather than a style choice.
   *
   * Every control that SAVES A FILE is a button, because saving a file is a decision that depends
   * on what came back: a `<a download>` cannot read a response, so the eligibility anchor saved a
   * 409 JSON body to disk under the name `eligibility.csv` and the page said nothing. The one that
   * OPENS A PAGE is still a link, because opening a tab needs the user's own click and an anchor
   * is the only thing that has it.
   */
  it('offers the opportunity, eligibility and calendar downloads', async () => {
    stubFetch();
    render(<MemoryRouter><ExportsRoute /></MemoryRouter>);
    expect(await screen.findByRole('button', { name: /opportunities \(csv\)/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /opportunities \(xlsx\)/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /eligibility report \(csv\)/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /printable eligibility report/i })).toBeInTheDocument();
    // Anchored: there are two one-off controls, the whole corpus and the watchlist.
    expect(screen.getByRole('button', { name: /^one-off \.ics$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^one-off \.ics \(watchlist only\)$/i })).toBeInTheDocument();
    // Nothing on this screen may hand the browser an export URL to save unread.
    for (const link of screen.getAllByRole('link')) {
      expect(link.getAttribute('href') ?? '').not.toMatch(/\/api\/exports\/(opportunities|eligibility\.csv|deadlines)/);
    }
  });

  /**
   * BOTH URLs, because the user is now the one choosing the scope. Exactly one label says
   * "Subscribe URL" — the corpus-wide one, which is the default — so `getByLabel(/subscribe url/i)`
   * stays unambiguous for this suite and for e2e/flow.spec.ts, which reads that field to prove the
   * feed serves.
   */
  it('shows both subscribe URLs exactly once, after creating a feed', async () => {
    stubFetch({
      createToken: () => jsonResponse({ url: 'http://127.0.0.1:3030/calendar/abc.ics', token: 'abc' }),
    });
    render(<MemoryRouter><ExportsRoute /></MemoryRouter>);

    await userEvent.click(await screen.findByRole('button', { name: /create a calendar feed/i }));
    const field = await screen.findByLabelText(/subscribe url/i);
    expect(field).toHaveValue('http://127.0.0.1:3030/calendar/abc.ics');
    expect(screen.getByLabelText(/watchlist feed/i)).toHaveValue(
      'http://127.0.0.1:3030/calendar/abc.ics?watched=1',
    );
    // Labelled with what each will contain, so the choice is made deliberately and not by default.
    expect(screen.getByText(/every deadline/i)).toBeInTheDocument();
    expect(screen.getByText(/only what you star/i)).toBeInTheDocument();
    expect(screen.getByText(/shown once/i)).toBeInTheDocument();
  });

  it('reports that a feed already exists without pretending to know the URL', async () => {
    stubFetch({ icsToken: () => jsonResponse({ hasToken: true }) });
    render(<MemoryRouter><ExportsRoute /></MemoryRouter>);
    expect(await screen.findByText(/a calendar feed already exists/i)).toBeInTheDocument();
    // It cannot reprint the token, but it can say how to build the other URL out of one they have.
    expect(screen.getByText(/watchlist-only variant/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /rotate/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /revoke/i })).toBeInTheDocument();
  });

  it('explains what PDF means here instead of offering a fake PDF button', async () => {
    stubFetch();
    render(<MemoryRouter><ExportsRoute /></MemoryRouter>);
    expect(await screen.findByText(/Print \/ Save as PDF/)).toBeInTheDocument();
  });

  /**
   * THIS REPLACES AN ASSERTION THAT PINNED A FALSE STATISTIC ON SCREEN. It required this route to
   * render "4 of the 243 dated windows in this corpus are dates a funder has actually published",
   * so the copy could not be corrected without correcting the test in the same commit — which is
   * how the sentence outlived the pass that removed it from the other five components.
   *
   * 4-of-243 is a real measurement of the FIXTURE corpus on a fixed clock, and a lie on this
   * screen, which a user reads against whatever corpus is installed. On `data/seed/` the figure is
   * not a constant at all: 252 cycles with 2 funder-published on 2026-08-04, 250 with 1 on
   * 2026-10-01, 248 with 0 on 2027-02-01, as `test/cycleCountCopy.test.ts` records.
   *
   * The assertion is not weakened, it is moved onto what is actually provable. The claim the
   * screen now makes — every date declares which kind it is, and a projection carries four marks —
   * is asserted here in both directions: the sentence must be present, AND no count of dated
   * things may be on screen. The second half is DOM-level on purpose. `cycleCountCopy` sweeps
   * SOURCE, so a figure assembled at render time (`{'4 of '}{total} windows`) is invisible to it
   * and would be exactly what a determined edit produces.
   */
  it('says every calendar date declares whether the funder published it, without counting them', async () => {
    stubFetch();
    render(<MemoryRouter><ExportsRoute /></MemoryRouter>);

    const note = await screen.findByText(/every date in these files/i);
    expect(note).toHaveTextContent(/the funder\s+published/i);
    expect(note).toHaveTextContent(/projected from the recurrence/i);
    // The four marks `exports/ics.ts` writes and `exports/ics.test.ts` proves, named as four
    // because they are four lines of code, not four rows of a corpus.
    expect(note).toHaveTextContent(/marked four ways/i);
    expect(note).toHaveTextContent(/\(estimated\)/i);
    expect(note).toHaveTextContent(/tentative status/i);

    const onScreen = (document.body.textContent ?? '').replace(/\s+/g, ' ');
    expect(
      onScreen,
      'A count of dated windows/cycles/events rendered here goes stale on its own clock. Say the ' +
        'distinction, which is proved, and leave the arithmetic to a screen that holds the rows.',
    ).not.toMatch(
      /\b(?:\d{1,4}|one|two|three|four|five|six|seven|eight|nine|ten)\b(?:\s+(?:of|in)\s+[^.!?]{0,50}?)?\s+(?:cycles|windows|deadlines|dates|events|entries|items|records|rows|programmes|programs)\b/i,
    );
  });

  /**
   * THIS TEST REPLACES ONE THAT PINNED THE DEFECT'S OWN COPY. It asserted that this screen said
   * "the feed follows your watchlist" and that "the URL does not change" when it switches — both
   * accurate descriptions of a feed whose meaning moved underneath its subscriber, which is the
   * behaviour that has now been removed. The assertion was not weakened: the claim it checked is
   * gone from the product, and leaving it would have required the screen to keep describing a
   * failure mode instead of documenting a choice.
   */
  it('says there are two feed URLs and that each one keeps its meaning', async () => {
    stubFetch();
    render(<MemoryRouter><ExportsRoute /></MemoryRouter>);
    expect(await screen.findByText(/two feed urls/i)).toBeInTheDocument();
    expect(screen.getByText(/plain URL carries every\s+publishable deadline/i)).toBeInTheDocument();
    expect(screen.getByText(/only the programmes you star/i)).toBeInTheDocument();
    // The half a subscriber needs: what they do later cannot rewrite what they already installed.
    expect(screen.getByText(/never empties the plain one/i)).toBeInTheDocument();
  });

  it('surfaces a 409 from the eligibility export as the profile prompt', async () => {
    stubFetch({ icsToken: () => jsonResponse({ hasToken: true }) });
    render(<MemoryRouter><ExportsRoute /></MemoryRouter>);
    expect(await screen.findByText(/needs a profile/i)).toBeInTheDocument();
  });

  /**
   * THE FILE THAT LANDS ON DISK, AND THE SENTENCE ON THE SCREEN THAT SENT IT THERE.
   *
   * `URL.createObjectURL` is the one call `saveBlob` cannot do its job without, so counting it is
   * how this suite asks "did a file land?" without a filesystem. `test/setup.ts` stubs it into
   * jsdom, which has none; these tests spy on that stub.
   */
  describe('what actually lands on disk', () => {
    let saved: string[];

    beforeEach(() => {
      saved = [];
      vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
        saved.push('blob');
        return 'blob:test';
      });
    });
    afterEach(() => { vi.restoreAllMocks(); });

    it('saves the file the server named, and says so with the count in it', async () => {
      stubFetch({ download: () => fileResponse('id,funder\r\n', 'grantspotter-opportunities-2026-08-13.csv', 143) });
      render(<MemoryRouter><ExportsRoute /></MemoryRouter>);

      await userEvent.click(await screen.findByRole('button', { name: /opportunities \(csv\)/i }));
      expect(await screen.findByText(/grantspotter-opportunities-2026-08-13\.csv/)).toHaveTextContent(
        /143 programmes/,
      );
      expect(saved).toHaveLength(1);
    });

    /**
     * THE DEFECT, IN THE STATE THAT PRODUCED IT. As a member with no profile the page warned "it
     * needs a profile" and then both controls fired anyway: Chromium saved
     * `{"error":{"code":"conflict","message":"Set up a profile first; …"}}` as a file called
     * `eligibility.csv`, and nothing on screen changed.
     */
    it('never saves a refusal as though it were the report', async () => {
      stubFetch({
        profiles: () => jsonResponse(NO_PROFILE_BODY),
        download: () =>
          jsonResponse(
            { error: { code: 'conflict', message: 'Set up a profile first; there is nothing to match against.' } },
            409,
          ),
      });
      render(<MemoryRouter><ExportsRoute /></MemoryRouter>);

      // With no profile the controls are off, and the reason is on the page rather than in a file.
      const csv = await screen.findByRole('button', { name: /eligibility report \(csv\)/i });
      expect(csv).toBeDisabled();
      expect(screen.getByRole('button', { name: /printable eligibility report/i })).toBeDisabled();
      expect(screen.queryByRole('link', { name: /printable eligibility report/i })).toBeNull();
      // The whole sentence, including what it promises will happen once there is a profile.
      expect(screen.getByText(/no profile on this account yet, so there is no report to make/i))
        .toBeInTheDocument();
      expect(screen.getByText(/and both controls here start working/i)).toBeInTheDocument();
      await userEvent.click(csv);
      expect(saved).toEqual([]);
    });

    /**
     * THE OTHER ZERO, AND IT IS A DIFFERENT SENTENCE. An opportunities export that comes back with
     * no rows means this deployment is publishing nothing at all — not that a filter was narrow,
     * and not that anything failed. A student who found a header-only spreadsheet in their
     * downloads folder a week later would have no way to tell those three apart.
     */
    it('writes no spreadsheet when the corpus published nothing, and says which nothing it was', async () => {
      stubFetch({ download: () => fileResponse('id,funder\r\n', 'grantspotter-opportunities-2026-08-13.csv', 0) });
      render(<MemoryRouter><ExportsRoute /></MemoryRouter>);

      await userEvent.click(await screen.findByRole('button', { name: /opportunities \(csv\)/i }));
      const said = await screen.findByText(/there is nothing to export/i);
      expect(said).toHaveTextContent(/publishing no programmes at all/i);
      expect(said).toHaveTextContent(/so no file was written\./);
      expect(saved).toEqual([]);
    });

    /**
     * The same shape from the other direction: a profile that was deleted in another tab, or any
     * refusal at all. The control is live, the request goes out, and the answer is a sentence on
     * this page instead of a file with a JSON body in it.
     */
    it('prints the server’s own refusal on the page and saves nothing', async () => {
      stubFetch({
        download: () =>
          jsonResponse(
            { error: { code: 'conflict', message: 'Set up a profile first; there is nothing to match against.' } },
            409,
          ),
      });
      render(<MemoryRouter><ExportsRoute /></MemoryRouter>);

      await userEvent.click(await screen.findByRole('button', { name: /eligibility report \(csv\)/i }));
      expect(await screen.findByRole('alert')).toHaveTextContent(/set up a profile first/i);
      expect(saved).toEqual([]);
    });

    /**
     * "An empty file downloaded silently" is the same defect wearing different clothes: a
     * watchlist calendar with nothing starred is a valid `.ics` with no VEVENT in it. A file in a
     * downloads folder is read later, out of this context, as an answer.
     */
    it('does not write an empty calendar, and says why there was nothing to write', async () => {
      stubFetch({
        download: (url) =>
          url.includes('watched=1')
            ? fileResponse('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', 'grantspotter-deadlines-2026-08-13.ics', 0, 'text/calendar')
            : fileResponse('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\n', 'grantspotter-deadlines-2026-08-13.ics', 252, 'text/calendar'),
      });
      render(<MemoryRouter><ExportsRoute /></MemoryRouter>);

      await userEvent.click(await screen.findByRole('button', { name: /^one-off \.ics \(watchlist only\)$/i }));
      const empty = await screen.findByText(/watchlist has no dated deadlines/i);
      expect(empty).toHaveTextContent(/so that calendar would have been empty and no file was written/i);
      expect(saved).toEqual([]);

      // ...and the plain feed, which has dates in it, still saves and still reports what it saved.
      await userEvent.click(screen.getByRole('button', { name: /^one-off \.ics$/i }));
      expect(await screen.findByText(/252 dates/)).toBeInTheDocument();
      expect(saved).toHaveLength(1);
    });
  });
});
