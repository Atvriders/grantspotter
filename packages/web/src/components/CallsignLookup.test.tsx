import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CallsignLookup, type CallsignTarget } from './CallsignLookup.js';
import type { CallsignLookupResult, CallsignRecord } from '../api/callsign.js';
import { auditA11y } from '../test/a11y.js';

/**
 * THE ONE CONTROL IN THIS PRODUCT THAT PUTS A VALUE ABOUT THE USER ON SCREEN WITHOUT ASKING
 * THEM FOR IT.
 *
 * Every test below is one of the ways that can go wrong: a status that reads as a failure when
 * it is not one, a licence class guessed upward, a street address quietly kept, or a value
 * filled in that nobody pressed a button to accept.
 */

const PERSON: CallsignRecord = {
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
  expiryDate: '2029-04-04',
  frn: '0012345678',
  ulsUrl: 'https://wireless2.fcc.gov/UlsApp/UlsSearch/license.jsp?licKey=1234',
  source: 'callook.info',
  fetchedAt: '2026-08-04T12:00:00.000Z',
};

/** A collegiate club station: no operator class, and an organisation in the name field. */
const CLUB: CallsignRecord = {
  callsign: 'W8UM',
  type: 'CLUB',
  name: 'UNIVERSITY OF MICHIGAN AMATEUR RADIO CLUB',
  addressLine1: 'P.O. BOX 8550',
  city: 'ANN ARBOR',
  state: 'MI',
  zip: '48107',
  isPoBox: true,
  grantDate: '2021-06-01',
  frn: '0098765432',
  source: 'callook.info',
  fetchedAt: '2026-08-04T12:00:00.000Z',
};

/** One of the ~212k legacy licences: kept verbatim, mapped to nothing. */
const LEGACY: CallsignRecord = {
  ...PERSON,
  operClass: undefined,
  operClassRaw: 'ADVANCED',
};

function stubResult(result: CallsignLookupResult): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(() =>
    Promise.resolve({ ok: true, status: 200, json: async () => result } as unknown as Response),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function stubError(status: number, code: string, message: string): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(() =>
    Promise.resolve({
      ok: false,
      status,
      json: async () => ({ error: { code, message }, requestId: 'req-1' }),
    } as unknown as Response),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderLookup(
  options: { callsign?: string; target?: CallsignTarget; setupToken?: string } = {},
) {
  const onAccept = vi.fn();
  const view = render(
    <CallsignLookup
      callsign={options.callsign ?? 'w8um'}
      target={options.target ?? 'student'}
      onAccept={onAccept}
      {...(options.setupToken === undefined ? {} : { setupToken: options.setupToken })}
      clubNotice="Club details belong on the organization profile."
    />,
  );
  return { onAccept, ...view };
}

function lookUp(): Promise<void> {
  return userEvent.click(screen.getByRole('button', { name: /look up this callsign/i }));
}

/** The always-mounted live region, which is how the answer is ANNOUNCED and not merely drawn. */
function liveRegion(container: HTMLElement): HTMLElement {
  const node = container.querySelector<HTMLElement>('[aria-live="polite"]');
  if (node === null) throw new Error('no live region is mounted');
  return node;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the five statuses, each answered in its own words', () => {
  it('shows the record when one is found, and fills nothing in by itself', async () => {
    stubResult({ status: 'found', record: PERSON });
    const { onAccept } = renderLookup();
    await lookUp();

    expect(await screen.findByRole('heading', { name: /FCC record for W8UM/i })).toBeInTheDocument();
    expect(screen.getByText('JANE Q OPERATOR')).toBeInTheDocument();
    // Nothing was accepted: the panel is an offer, not an auto-fill.
    expect(onAccept).not.toHaveBeenCalled();
  });

  it('does not read a missing record as a judgement about the person', async () => {
    stubResult({
      status: 'not_found',
      message: 'callook.info has no current FCC record for "W8ZZZ".',
    });
    const { container } = renderLookup({ callsign: 'W8ZZZ' });
    await lookUp();

    const panel = await screen.findByRole('region', { name: /no active licence record/i });
    expect(panel).toHaveTextContent(/not a judgement about you/i);
    // The server's own sentence is kept beside the framing rather than replacing it.
    expect(panel).toHaveTextContent(/no current FCC record/i);
    expect(liveRegion(container)).toHaveTextContent(/no active licence record for W8ZZZ/i);
  });

  /**
   * The one that must not look like a failure. An operator holding a perfectly valid German
   * licence has done nothing wrong, and "not found" at account creation reads as "your licence
   * is invalid".
   */
  it('tells a non-US operator that nothing is wrong, in as many words', async () => {
    stubResult({
      status: 'not_us',
      message: 'GrantSpotter can only look up United States callsigns automatically.',
    });
    renderLookup({ callsign: 'DL1ABC' });
    await lookUp();

    const panel = await screen.findByRole('region', { name: /not a US callsign/i });
    expect(panel).toHaveTextContent(/this is not an error/i);
    expect(panel).toHaveTextContent(/nothing is wrong with your licence/i);
    expect(panel).toHaveTextContent(/works exactly the same way for you/i);
    expect(panel.textContent ?? '').not.toMatch(/invalid|failed|not found/i);
  });

  it('says the source is mid-import rather than that the callsign is missing', async () => {
    stubResult({ status: 'updating', message: 'callook.info is reloading its copy.' });
    renderLookup();
    await lookUp();

    const panel = await screen.findByRole('region', { name: /re-importing the FCC database/i });
    expect(panel).toHaveTextContent(/says nothing about your callsign/i);
    expect(panel.textContent ?? '').not.toMatch(/not found|no record/i);
  });

  it('says nothing either way when the source could not be reached', async () => {
    stubResult({ status: 'unavailable', message: 'We could not reach callook.info.' });
    renderLookup();
    await lookUp();

    const panel = await screen.findByRole('region', { name: /did not get an answer/i });
    expect(panel).toHaveTextContent(/not telling you anything about this callsign either way/i);
    expect(panel).toHaveTextContent(/nothing on this form was changed/i);
  });

  /** A refusal from our own API is not an answer about the callsign either. */
  it('reports a rate-limited refusal in the server’s own words', async () => {
    stubError(429, 'rate_limited', 'That is more callsign lookups than one person makes.');
    renderLookup();
    await lookUp();

    const panel = await screen.findByRole('region', { name: /did not run/i });
    expect(panel).toHaveTextContent(/more callsign lookups than one person makes/i);
    expect(panel).toHaveTextContent(/nothing on this form was changed/i);
  });

  it('does not blame the callsign when the API is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    renderLookup();
    await lookUp();

    expect(await screen.findByRole('region', { name: /did not run/i })).toHaveTextContent(
      /could not be reached/i,
    );
  });
});

describe('accept, edit, dismiss', () => {
  it('hands the host the values, with the provenance that goes with them', async () => {
    stubResult({ status: 'found', record: PERSON });
    const { onAccept, container } = renderLookup();
    await lookUp();
    await userEvent.click(await screen.findByRole('button', { name: /use these values/i }));

    expect(onAccept).toHaveBeenCalledWith({
      callsign: 'W8UM',
      type: 'PERSON',
      state: 'MI',
      licenseClass: 'GENERAL',
      provenance: {
        source: 'callook.info',
        fetchedAt: '2026-08-04T12:00:00.000Z',
        ulsUrl: 'https://wireless2.fcc.gov/UlsApp/UlsSearch/license.jsp?licKey=1234',
      },
    });
    expect(liveRegion(container)).toHaveTextContent(/nothing has been saved yet/i);
  });

  it('accepts what the user edited, not what the source said', async () => {
    stubResult({ status: 'found', record: PERSON });
    const { onAccept } = renderLookup();
    await lookUp();

    const state = await screen.findByLabelText(/state to fill in/i);
    await userEvent.clear(state);
    await userEvent.type(state, 'ca');
    await userEvent.selectOptions(screen.getByLabelText(/license class to fill in/i), 'EXTRA');
    await userEvent.click(screen.getByRole('button', { name: /use these values/i }));

    expect(onAccept.mock.calls[0]?.[0]).toMatchObject({ state: 'CA', licenseClass: 'EXTRA' });
  });

  it('discards the record without filling anything in', async () => {
    stubResult({ status: 'found', record: PERSON });
    const { onAccept } = renderLookup();
    await lookUp();
    await userEvent.click(await screen.findByRole('button', { name: /discard/i }));

    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: /FCC record for/i })).not.toBeInTheDocument();
    });
    expect(onAccept).not.toHaveBeenCalled();
  });

  it('sends the callsign the user typed, normalised, and nothing else', async () => {
    const fetchMock = stubResult({ status: 'found', record: PERSON });
    renderLookup({ callsign: ' w8um ', setupToken: 'setup-token-1' });
    await lookUp();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/callsign/lookup');
    expect(JSON.parse(String(init.body))).toEqual({
      callsign: 'W8UM',
      setupToken: 'setup-token-1',
    });
  });

  it('cannot be pressed with an empty callsign box', () => {
    stubResult({ status: 'found', record: PERSON });
    renderLookup({ callsign: '   ' });
    expect(screen.getByRole('button', { name: /look up this callsign/i })).toBeDisabled();
  });
});

describe('what is shown and what is kept', () => {
  it('shows the address to confirm identity and says it is not stored', async () => {
    stubResult({ status: 'found', record: PERSON });
    const { onAccept } = renderLookup();
    await lookUp();

    expect(await screen.findByText(/1301 BEAL AVE/)).toBeInTheDocument();
    expect(screen.getByText(/GrantSpotter does not store it/i)).toBeInTheDocument();
    expect(screen.getByText(/no field for a street address/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /use these values/i }));
    const accepted = onAccept.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(accepted).not.toHaveProperty('addressLine1');
    expect(accepted).not.toHaveProperty('city');
    expect(accepted).not.toHaveProperty('zip');
    expect(accepted).not.toHaveProperty('name');
    // The one thing the address is mined for, because eligibility rules are written in states.
    expect(accepted.state).toBe('MI');
  });

  it('names the source and the day, and links the FCC’s own copy of the record', async () => {
    stubResult({ status: 'found', record: PERSON });
    renderLookup();
    await lookUp();

    const source = await screen.findByText(/republishes the FCC/i);
    expect(source).toHaveTextContent('callook.info');
    expect(source).toHaveTextContent('2026-08-04');
    const link = screen.getByRole('link', { name: /this record in the FCC ULS/i });
    expect(link).toHaveAttribute('href', PERSON.ulsUrl);
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  /**
   * `grantDate` resets on every renewal and every vanity change. `licensedSince` feeds
   * `heldMonthsMin` in the matcher, so filling it from this date would produce a confidently
   * wrong eligibility verdict.
   */
  it('labels the grant date for what it is and never offers it as “licensed since”', async () => {
    stubResult({ status: 'found', record: PERSON });
    const { onAccept } = renderLookup();
    await lookUp();

    expect(await screen.findByText(/current licence granted/i)).toBeInTheDocument();
    expect(screen.getByText(/never fills .licensed since. from it/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/licensed since/i)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /use these values/i }));
    expect(onAccept.mock.calls[0]?.[0]).not.toHaveProperty('licensedSince');
    expect(onAccept.mock.calls[0]?.[0]).not.toHaveProperty('grantDate');
  });
});

describe('a club station, which is what a collegiate club holds', () => {
  it('offers the organisation name and no operator class at all', async () => {
    stubResult({ status: 'found', record: CLUB });
    const { onAccept } = renderLookup({ target: 'organization' });
    await lookUp();

    expect(await screen.findByText('Club station')).toBeInTheDocument();
    expect(screen.getByText(/club station licence has no operator class/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/license class to fill in/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Club details belong on the organization profile/i)).toBeInTheDocument();
    // The PO box is stated rather than presented as a street address.
    expect(screen.getByText(/PO box rather than a street address/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /use these values/i }));
    expect(onAccept).toHaveBeenCalledWith(
      expect.objectContaining({
        callsign: 'W8UM',
        type: 'CLUB',
        state: 'MI',
        orgName: 'UNIVERSITY OF MICHIGAN AMATEUR RADIO CLUB',
      }),
    );
    expect(onAccept.mock.calls[0]?.[0]).not.toHaveProperty('licenseClass');
  });

  it('does not offer an organisation name on the student profile, which has no such field', async () => {
    stubResult({ status: 'found', record: CLUB });
    const { onAccept } = renderLookup({ target: 'student' });
    await lookUp();
    await userEvent.click(await screen.findByRole('button', { name: /use these values/i }));

    expect(screen.queryByLabelText(/organization name to fill in/i)).not.toBeInTheDocument();
    expect(onAccept.mock.calls[0]?.[0]).not.toHaveProperty('orgName');
  });
});

describe('a legacy operator class, which maps onto nothing', () => {
  it('leaves the class unset, says why, and lets the user pick', async () => {
    stubResult({ status: 'found', record: LEGACY });
    const { onAccept } = renderLookup();
    await lookUp();

    // The record's own word is kept and shown...
    const prompt = await screen.findByText(/nothing has been chosen for you/i);
    expect(prompt).toHaveTextContent('ADVANCED');
    expect(screen.getAllByText('ADVANCED').length).toBeGreaterThan(0);
    // ...and nothing was chosen from it.
    expect(screen.getByLabelText(/license class to fill in/i)).toHaveValue('');

    await userEvent.click(screen.getByRole('button', { name: /use these values/i }));
    // Accepting without choosing fills no licence class — never the neighbour above it.
    expect(onAccept.mock.calls[0]?.[0]).not.toHaveProperty('licenseClass');
  });

  it('takes the class the user picks for themselves', async () => {
    stubResult({ status: 'found', record: LEGACY });
    const { onAccept } = renderLookup();
    await lookUp();

    await userEvent.selectOptions(
      await screen.findByLabelText(/license class to fill in/i),
      'GENERAL',
    );
    await userEvent.click(screen.getByRole('button', { name: /use these values/i }));

    expect(onAccept.mock.calls[0]?.[0]).toMatchObject({ licenseClass: 'GENERAL' });
  });
});

describe('accessibility', () => {
  it('has no violations with a record on screen', async () => {
    stubResult({ status: 'found', record: PERSON });
    const { container } = render(
      <>
        <h1>Profile</h1>
        <CallsignLookup callsign="W8UM" target="student" onAccept={() => undefined} />
      </>,
    );
    await lookUp();
    await screen.findByRole('heading', { name: /FCC record for W8UM/i });
    expect(auditA11y(container)).toEqual([]);
  });

  it('has no violations with a refusal on screen', async () => {
    stubResult({ status: 'not_us', message: 'Not a US callsign.' });
    const { container } = render(
      <>
        <h1>Profile</h1>
        <CallsignLookup callsign="DL1ABC" target="student" onAccept={() => undefined} />
      </>,
    );
    await lookUp();
    await screen.findByRole('region', { name: /not a US callsign/i });
    expect(auditA11y(container)).toEqual([]);
  });
});
