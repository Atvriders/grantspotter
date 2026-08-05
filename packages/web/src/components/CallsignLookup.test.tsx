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

  /**
   * `unavailable` IS NOT ONE THING, SO ITS FRAME MAY NOT CLAIM TO BE.
   *
   * It read "The lookup did not get an answer" over "GrantSpotter could not reach callook.info",
   * and the server uses this status for at least seven different endings. Two kinds of them make
   * both sentences false: callook.info ANSWERING — with a redirect, a status, or bytes that are not
   * a licence record — is not a failure to reach it; and a cooldown hold is GrantSpotter
   * deliberately not asking a source that asked to be left alone, which is the opposite of being
   * unable to. Telling a user the source was unreachable when it replied, or when we chose not to
   * ask, is this product describing its own behaviour wrongly.
   *
   * The frame now says only what is true of all of them, and the server's own sentence — the half
   * that knows which ending it was — is rendered beneath it unedited, as it always was.
   */
  it.each([
    ['a genuine network failure', 'We could not reach callook.info, so nothing was filled in.'],
    [
      'a hold the source asked for',
      'callook.info asked GrantSpotter to wait before asking it again, so no request was sent this time.',
    ],
    [
      'a redirect GrantSpotter chose not to follow',
      'callook.info answered with a redirect (HTTP 301) rather than a licence record, and GrantSpotter did not follow it.',
    ],
    [
      'a body that arrived unreadable',
      'callook.info answered with something we could not read as a licence record.',
    ],
  ])('frames %s without claiming the source was unreachable', async (_what, message) => {
    stubResult({ status: 'unavailable', message });
    renderLookup();
    await lookUp();

    const panel = await screen.findByRole('region', { name: /nothing was filled in for W8UM/i });
    expect(panel).toHaveTextContent(/not telling you anything about this callsign either way/i);
    expect(panel).toHaveTextContent(/nothing on this form was changed/i);
    // The claim that was false for three of these four, and is now made about none of them.
    expect(panel.textContent ?? '').not.toMatch(/GrantSpotter could not reach callook\.info, so it/);
    expect(panel).toHaveTextContent(/does not necessarily mean the source was unreachable/i);
    // The server's sentence is what says which ending it was, and it is not paraphrased.
    expect(panel).toHaveTextContent(message);
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
      // Every value carries WHO STATED IT. The state and the class are the record's own, untouched;
      // the callsign is what the user typed, and the record merely agreed with it.
      callsign: { value: 'W8UM', origin: 'user' },
      type: 'PERSON',
      state: { value: 'MI', origin: 'source' },
      licenseClass: { value: 'GENERAL', origin: 'source' },
      provenance: {
        source: 'callook.info',
        fetchedAt: '2026-08-04T12:00:00.000Z',
        ulsUrl: 'https://wireless2.fcc.gov/UlsApp/UlsSearch/license.jsp?licKey=1234',
      },
    });
    expect(liveRegion(container)).toHaveTextContent(/nothing has been saved yet/i);
  });

  /**
   * THE EDIT IS THE USER'S, AND IT LEAVES HERE SAYING SO.
   *
   * This panel is an editor, so a value can leave it having come from the person rather than from
   * the record — and it used to leave carrying the record's provenance regardless. A host cannot
   * tell the two apart from a bare string, so the origin travels with the value.
   */
  it('accepts what the user edited, and labels it as theirs rather than the source’s', async () => {
    stubResult({ status: 'found', record: PERSON });
    const { onAccept } = renderLookup();
    await lookUp();

    const state = await screen.findByLabelText(/state to fill in/i);
    await userEvent.clear(state);
    await userEvent.type(state, 'ca');
    await userEvent.selectOptions(screen.getByLabelText(/license class to fill in/i), 'EXTRA');
    await userEvent.click(screen.getByRole('button', { name: /use these values/i }));

    expect(onAccept.mock.calls[0]?.[0]).toMatchObject({
      state: { value: 'CA', origin: 'user' },
      licenseClass: { value: 'EXTRA', origin: 'user' },
    });
  });

  it('labels a value edited back to what the record said as the record’s again', async () => {
    // The label is a comparison, not a "was this input touched" flag: callook DID say MI, and it
    // says so however the box arrived back at MI.
    stubResult({ status: 'found', record: PERSON });
    const { onAccept } = renderLookup();
    await lookUp();

    const state = await screen.findByLabelText(/state to fill in/i);
    await userEvent.clear(state);
    await userEvent.type(state, 'mi');
    await userEvent.click(screen.getByRole('button', { name: /use these values/i }));

    expect(onAccept.mock.calls[0]?.[0]).toMatchObject({ state: { value: 'MI', origin: 'source' } });
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
    expect(accepted.state).toEqual({ value: 'MI', origin: 'source' });
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

/**
 * THE CONFIRMATION IS A CLAIM, AND IT HAS TO BE TRUE OF WHAT JUST HAPPENED.
 *
 * The panel is an editor, and `fillFromLookup` marks only what the RECORD stated — so
 * "Filled in from the FCC record" and "These are values GrantSpotter read, not values you stated"
 * were printed over sets of values the record had stated none of: a licence class the applicant
 * picked because the panel asked them to, a state they corrected, a callsign they typed. The
 * sentence appeared whether or not anything had been attributed, which is worth nothing on the
 * occasions when it is true.
 */
describe('what the confirmation claims was filled in', () => {
  it('names the fields the record stated, and says which are the applicant’s own', async () => {
    stubResult({ status: 'found', record: PERSON });
    const { container } = renderLookup();
    await lookUp();
    await userEvent.click(await screen.findByRole('button', { name: /use these values/i }));

    const panel = await screen.findByRole('region', { name: /filled in from the FCC record/i });
    expect(panel).toHaveTextContent(/State and License class came from the record/i);
    // The callsign is the question the applicant asked, so the record agreeing with it attributes
    // nothing — and the panel says so rather than sweeping it in with the other two.
    expect(panel).toHaveTextContent(/Callsign carries no mark/i);
    expect(liveRegion(container)).toHaveTextContent(/Filled in from the FCC record/i);
  });

  it('does not claim a record filled anything in when the record stated none of it', async () => {
    stubResult({ status: 'found', record: LEGACY });
    const { onAccept, container } = renderLookup();
    await lookUp();

    const state = await screen.findByLabelText(/state to fill in/i);
    await userEvent.clear(state);
    await userEvent.type(state, 'OH');
    await userEvent.selectOptions(screen.getByLabelText(/license class to fill in/i), 'EXTRA');
    await userEvent.click(screen.getByRole('button', { name: /use these values/i }));

    // Every value that left is the applicant's: a state they corrected, a class they picked for a
    // record whose ADVANCED maps onto none of GrantSpotter's four, and the callsign they typed.
    expect(onAccept.mock.calls[0]?.[0]).toMatchObject({
      callsign: { value: 'W8UM', origin: 'user' },
      state: { value: 'OH', origin: 'user' },
      licenseClass: { value: 'EXTRA', origin: 'user' },
    });

    expect(
      screen.queryByRole('heading', { name: /filled in from the FCC record/i }),
    ).not.toBeInTheDocument();
    const panel = await screen.findByRole('region', { name: /none of it attributed/i });
    expect(panel).toHaveTextContent(
      /Callsign, State and License class went onto the form as your own values/i,
    );
    expect(panel).toHaveTextContent(/only where the record itself stated what is now in it/i);
    // The record is still named and still linkable — it was read, and the applicant may want to
    // check it. What is gone is the claim that it filled these in.
    expect(panel).toHaveTextContent(/callook\.info/i);
    expect(liveRegion(container)).toHaveTextContent(/none of it attributed to the FCC record/i);
  });

  it('names an organisation profile’s own fields, on the tab that has them', async () => {
    stubResult({ status: 'found', record: CLUB });
    renderLookup({ target: 'organization' });
    await lookUp();
    await userEvent.click(await screen.findByRole('button', { name: /use these values/i }));

    const panel = await screen.findByRole('region', { name: /filled in from the FCC record/i });
    // In `acceptedValues`' own order, which is written out there field by field.
    expect(panel).toHaveTextContent(/State and Organization name came from the record/i);
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
        callsign: { value: 'W8UM', origin: 'user' },
        type: 'CLUB',
        state: { value: 'MI', origin: 'source' },
        orgName: {
          value: 'UNIVERSITY OF MICHIGAN AMATEUR RADIO CLUB',
          origin: 'source',
        },
      }),
    );
    expect(onAccept.mock.calls[0]?.[0]).not.toHaveProperty('licenseClass');
  });

  /**
   * A PERSONAL LICENCE LOOKED UP ON THE ORGANIZATION TAB, WHICH IS WHAT HAPPENS THE FIRST TIME
   * SOMEBODY TYPES THEIR OWN CALLSIGN THERE.
   *
   * `offersLicenseClass` has always hidden the select for this case — a licence class is a person's
   * and only the student profile has a field for one — but until 2026-08-04 it gated the SELECT
   * only. `licenseClass` is seeded from `record.operClass`, so GENERAL left the panel anyway,
   * labelled as callook.info's (it was), for a profile with nowhere to put it and from an input
   * nobody had seen. The confirmation then named "License class" to a club — a student field, on a
   * sentence about an organisation's profile — because a missing `organization:licenseClass` falls
   * through the registry to the student entry. Its neighbour `orgName` has carried exactly this
   * guard since it was written; this is the same guard on the same line's twin.
   */
  it('does not hand an organisation profile a licence class it has no field for', async () => {
    stubResult({ status: 'found', record: PERSON });
    const { onAccept } = renderLookup({ target: 'organization' });
    await lookUp();

    // Never on screen, and now it does not leave either.
    expect(screen.queryByLabelText(/license class to fill in/i)).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: /use these values/i }));
    expect(onAccept.mock.calls[0]?.[0]).not.toHaveProperty('licenseClass');

    const panel = await screen.findByRole('region', { name: /filled in from the FCC record/i });
    expect(panel).toHaveTextContent(/State came from the record/i);
    expect(panel).toHaveTextContent(/Callsign carries no mark/i);
    // The label that used to reach an organisation's confirmation.
    expect(panel.textContent ?? '').not.toMatch(/licen[cs]e class/i);
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

  /**
   * THE CLASS THE USER PICKS IS THE USER'S, AND THIS IS THE CASE THE WHOLE `origin` LABEL EXISTS
   * FOR.
   *
   * The panel opens UNSET for a legacy class and asks the applicant to choose — so a choice made
   * here is theirs by construction, and there is nothing to compare it against: `operClass` is
   * `undefined` for ADVANCED. It used to leave labelled `callook.info` all the same, which put an
   * FCC attribution on a licence class the FCC record does not contain and made every eligibility
   * verdict downstream rest on it.
   */
  it.each(['GENERAL', 'EXTRA'] as const)(
    'takes %s as the user’s own answer, never as something ADVANCED implied',
    async (chosen) => {
      stubResult({ status: 'found', record: LEGACY });
      const { onAccept } = renderLookup();
      await lookUp();

      await userEvent.selectOptions(
        await screen.findByLabelText(/license class to fill in/i),
        chosen,
      );
      await userEvent.click(screen.getByRole('button', { name: /use these values/i }));

      expect(onAccept.mock.calls[0]?.[0]).toMatchObject({
        licenseClass: { value: chosen, origin: 'user' },
      });
    },
  );
});

/**
 * A SUPERSEDED CALLSIGN, WHICH IS THE ONE ANSWER THAT CHANGES A VALUE THE USER TYPED.
 *
 * callook answers a lookup of a superseded callsign with the licensee's CURRENT record — the
 * behaviour `callook.ts` documents beside `previous.callsign`. Accepting it used to turn K9OLD
 * into W5NEW with nothing said and nothing marked.
 */
describe('a record found under a different callsign', () => {
  const SUPERSEDED: CallsignRecord = { ...PERSON, callsign: 'W5NEW', name: 'ALEX Q EXAMPLE' };

  it('says whose record this is, and will not hand it over until the user confirms', async () => {
    stubResult({ status: 'found', record: SUPERSEDED });
    const { onAccept } = renderLookup({ callsign: 'K9OLD' });
    await lookUp();

    const panel = await screen.findByRole('region', { name: /FCC record for W5NEW/i });
    expect(panel).toHaveTextContent(/You asked about K9OLD/i);
    expect(panel).toHaveTextContent(/This record is for W5NEW/i);
    expect(panel).toHaveTextContent(/superseded callsign/i);
    // Both readings are offered, because this component cannot tell them apart.
    expect(panel).toHaveTextContent(/callsign they no longer hold/i);
    expect(panel).toHaveTextContent(/typo/i);

    // The offer is not takeable yet.
    const use = screen.getByRole('button', { name: /use these values/i });
    expect(use).toBeDisabled();
    await userEvent.click(use);
    expect(onAccept).not.toHaveBeenCalled();

    await userEvent.click(screen.getByLabelText(/this record is mine/i));
    expect(use).toBeEnabled();
    await userEvent.click(use);

    // ...and the callsign leaves as the SOURCE's answer, not as the user's question.
    expect(onAccept.mock.calls[0]?.[0]).toMatchObject({
      callsign: { value: 'W5NEW', origin: 'source' },
    });
  });

  it('lets the user discard it instead, having changed nothing', async () => {
    stubResult({ status: 'found', record: SUPERSEDED });
    const { onAccept } = renderLookup({ callsign: 'K9OLD' });
    await lookUp();
    await userEvent.click(await screen.findByRole('button', { name: /discard/i }));

    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: /FCC record for/i })).not.toBeInTheDocument();
    });
    expect(onAccept).not.toHaveBeenCalled();
  });

  it('asks nothing extra when the record is for the callsign that was typed', async () => {
    stubResult({ status: 'found', record: PERSON });
    renderLookup({ callsign: 'W8UM' });
    await lookUp();

    await screen.findByRole('button', { name: /use these values/i });
    expect(screen.getByRole('button', { name: /use these values/i })).toBeEnabled();
    expect(screen.queryByLabelText(/this record is mine/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/You asked about/i)).not.toBeInTheDocument();
  });

  /**
   * C3: the live region built its heading from the TYPED callsign while the visible heading used
   * the record's, so a screen-reader user was told "FCC record for K9OLD: ALEX Q EXAMPLE" about a
   * record that is W5NEW's — the substitution, described to the one user who cannot see it.
   */
  it('announces the record that is on screen, not the callsign that was typed', async () => {
    stubResult({ status: 'found', record: SUPERSEDED });
    const { container } = renderLookup({ callsign: 'K9OLD' });
    await lookUp();

    const heading = await screen.findByRole('heading', { name: /FCC record for/i });
    const live = liveRegion(container);
    await waitFor(() => {
      expect(live).toHaveTextContent(/ALEX Q EXAMPLE/);
    });
    expect(live.textContent ?? '').toContain(heading.textContent ?? '');
    expect(live).toHaveTextContent(/FCC record for W5NEW/i);
    expect(live).toHaveTextContent(/not the K9OLD you asked about/i);
    expect(live.textContent ?? '').not.toMatch(/FCC record for K9OLD/i);
  });

  it('does not announce a record when none was received', async () => {
    // `found` with no record is framed on screen as `unavailable` — nothing was received, so
    // nothing is claimed. The announcement has to say the same thing the panel does.
    stubResult({ status: 'found' });
    const { container } = renderLookup({ callsign: 'W8UM' });
    await lookUp();

    await screen.findByRole('region', { name: /nothing was filled in for W8UM/i });
    expect(liveRegion(container)).toHaveTextContent(/nothing was filled in for W8UM/i);
    expect(liveRegion(container).textContent ?? '').not.toMatch(/FCC record for/i);
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

  it('has no violations with a superseded-callsign confirmation on screen', async () => {
    stubResult({ status: 'found', record: { ...PERSON, callsign: 'W5NEW' } });
    const { container } = render(
      <>
        <h1>Profile</h1>
        <CallsignLookup callsign="K9OLD" target="student" onAccept={() => undefined} />
      </>,
    );
    await lookUp();
    await screen.findByLabelText(/this record is mine/i);
    expect(auditA11y(container)).toEqual([]);
  });

  it('has no violations with the confirmation on screen', async () => {
    stubResult({ status: 'found', record: PERSON });
    const { container } = render(
      <>
        <h1>Profile</h1>
        <CallsignLookup callsign="W8UM" target="student" onAccept={() => undefined} />
      </>,
    );
    await lookUp();
    await userEvent.click(await screen.findByRole('button', { name: /use these values/i }));
    await screen.findByRole('region', { name: /filled in from the FCC record/i });
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
