import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCoordinateAgainstLocator } from '@grantspotter/core';
import { describe, expect, it } from 'vitest';
import { FIXTURE_ROOT, loadFixture } from '../../test/fixtures.js';
import {
  CALLOOK_BASE_URL,
  CALLSIGN_LOOKUP_PURPOSE,
  lookupCallsign,
  wouldReachTheSource,
  type CallsignLookupDeps,
} from './callook.js';
import { COOLDOWN_FLOOR_MS, createHostCooldown, type HostCooldown } from './cooldown.js';
import type { GeocodedPoint, MailingGeocode } from './types.js';

/**
 * Every case here is driven by a file in `fixtures/callook/` — a real capture where committing one
 * is safe, and a hand-built body in the documented shape where it is not (a callsign record is
 * somebody's name and home address; see that directory's README).
 *
 * NOTHING IN THIS FILE REACHES THE NETWORK, and it cannot: `lookupCallsign` has no default
 * transport, so a test that forgot to inject one would not compile.
 */

const FIXTURES = path.join(FIXTURE_ROOT, 'callook');
const AT = '2026-08-04T22:07:30.000Z';

/**
 * A transport that answers every request with one body, and records what it was asked.
 *
 * Every harness here gets its OWN cooldown ledger. `cooldown` is required on `CallsignLookupDeps`
 * for the same reason `transport` is — a lookup that cannot remember what a host asked for cannot
 * honour it — and a shared one would carry one test's 429 into the next test's lookup.
 */
function serve(
  body: string,
  init: { status?: number; headers?: Record<string, string>; cooldown?: HostCooldown } = {},
): { deps: CallsignLookupDeps; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  return {
    calls,
    deps: {
      now: () => Date.parse(AT),
      cooldown: init.cooldown ?? createHostCooldown(),
      transport: (url, requestInit) => {
        calls.push({ url, init: requestInit });
        return Promise.resolve(
          new Response(body, {
            status: init.status ?? 200,
            headers: init.headers ?? { 'content-type': 'application/json; charset=utf-8' },
          }),
        );
      },
    },
  };
}

function serveFixture(file: string): ReturnType<typeof serve> {
  return serve(loadFixture('callook', file));
}

/** The wire shape, as far as anything below edits it. Every field is a string; callook sends no
 *  numbers, no nulls and no booleans, and writes "no data" as `""`. */
interface CallookBody {
  status: string;
  type: string;
  name: string;
  current: { callsign: string; operClass: string };
  previous: { callsign: string; operClass: string };
  address: { line1: string; line2: string; attn: string };
  /** Strings, all three of them, and `""` for "no data" — see `person-no-address.json`. */
  location: { latitude: string; longitude: string; gridsquare: string };
  otherInfo: { grantDate: string; expiryDate: string; frn: string; ulsUrl: string };
}

/**
 * The point out of whichever arm holds it — the exhaustive `switch` a consumer has to write, which
 * is the whole reason the three arms use three different keys. Written out here rather than
 * reached for with a cast, because a test that casts past the discriminant is a test that would
 * not notice the discriminant being removed.
 */
function statedPointOf(geocode: MailingGeocode): GeocodedPoint {
  switch (geocode.geocodedFrom) {
    case 'street_address':
      return geocode.mailingAddress;
    case 'po_box':
      return geocode.poBox;
    case 'address_not_stated':
      return geocode.unattributed;
  }
}

/** A fixture body with one field changed, for the shapes callook could serve but has not. */
function mutate(file: string, edit: (body: CallookBody) => void): string {
  const body = JSON.parse(loadFixture('callook', file)) as CallookBody;
  edit(body);
  return JSON.stringify(body);
}

describe('lookupCallsign: a live record', () => {
  it('reads the club station the primary audience actually has', async () => {
    const { deps, calls } = serveFixture('01-callook-info-w1mx-json.json');
    const result = await lookupCallsign('w1mx', deps);

    expect(result.status).toBe('found');
    expect(result.message).toBeUndefined();
    expect(result.record).toEqual({
      callsign: 'W1MX',
      type: 'CLUB',
      name: 'M I T RADIO SOCIETY',
      addressLine1: 'P.O. BOX 51421',
      city: 'BOSTON',
      state: 'MA',
      // Kept exactly as the record printed it, hyphen and all. See the ZIP+4 case below.
      zip: '02205-1421',
      isPoBox: true,
      // A post office in Boston, to eight decimal places, for a club that is at MIT in Cambridge.
      // Filed under `poBox` because that is what callook geocoded; see the location block below.
      mailingGeocode: {
        geocodedFrom: 'po_box',
        poBox: { latitude: 42.34991837, longitude: -71.0538559, gridsquare: 'FN42li' },
      },
      grantDate: '2024-08-10',
      expiryDate: '2034-08-24',
      frn: '0011325347',
      ulsUrl: 'https://wireless2.fcc.gov/UlsApp/UlsSearch/license.jsp?licKey=783425',
      source: 'callook.info',
      fetchedAt: AT,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${CALLOOK_BASE_URL}/W1MX/json`);
    expect(calls[0].init.method).toBe('GET');
    // Not followed, so that one call is one host, and that host has been past the blocklist.
    expect(calls[0].init.redirect).toBe('manual');
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it('leaves operClass unset for a club, which has no operator class at all', async () => {
    const { deps } = serveFixture('00-callook-info-w1aw-json.json');
    const result = await lookupCallsign('W1AW', deps);

    expect(result.record?.type).toBe('CLUB');
    expect(result.record?.name).toBe('ARRL HQ OPERATORS CLUB');
    // callook writes "no data" as the empty string. An empty string is not a class the source
    // stated, so neither field is invented from it.
    expect(result.record).not.toHaveProperty('operClass');
    expect(result.record).not.toHaveProperty('operClassRaw');
    expect(result.record?.isPoBox).toBe(false);
    expect(result.record?.city).toBe('NEWINGTON');
    expect(result.record?.state).toBe('CT');
    expect(result.record?.zip).toBe('06111');
  });

  it('sees a PO box that shares a line with a street address', async () => {
    const { deps } = serveFixture('02-callook-info-k2cc-json.json');
    const result = await lookupCallsign('K2CC', deps);

    expect(result.record?.addressLine1).toBe('8 CLARKSON AVE, P.O. BOX 8550');
    expect(result.record?.isPoBox).toBe(true);
    expect(result.record?.city).toBe('POTSDAM');
    expect(result.record?.state).toBe('NY');
  });

  it('answers with the callsign the licensee holds now, not the one that was asked for', async () => {
    // callook serves a superseded callsign's lookup from the holder's CURRENT record. Returning
    // the queried string would print our own input back as though the source had said it.
    const { deps } = serveFixture('person-extra.json');
    const result = await lookupCallsign('KV0ZZZ', deps);

    expect(result.status).toBe('found');
    expect(result.record?.callsign).toBe('WV0ZZZ');
    expect(result.record?.type).toBe('PERSON');
    expect(result.record?.name).toBe('ALEX Q EXAMPLE');
  });

  it('strips typed whitespace rather than reading it as a foreign callsign', async () => {
    const { deps, calls } = serveFixture('00-callook-info-w1aw-json.json');
    const result = await lookupCallsign('  w1 aw ', deps);

    expect(result.status).toBe('found');
    expect(calls[0].url).toBe(`${CALLOOK_BASE_URL}/W1AW/json`);
  });
});

describe('lookupCallsign: operator class', () => {
  it.each([
    ['person-technician.json', 'TECHNICIAN', 'TECH'],
    ['person-general.json', 'GENERAL', 'GENERAL'],
    ['person-extra.json', 'EXTRA', 'EXTRA'],
  ])('maps %s exactly', async (file, raw, mapped) => {
    const { deps } = serveFixture(file);
    const result = await lookupCallsign('WV0ZZZ', deps);

    expect(result.record?.operClassRaw).toBe(raw);
    expect(result.record?.operClass).toBe(mapped);
  });

  /**
   * The rule this product exists for. ~212,000 people hold one of these three, `LicenseClass` has
   * no value for any of them, and every available guess is upward — which manufactures an ELIGIBLE
   * verdict on an award the holder cannot enter.
   */
  it.each([
    ['person-advanced.json', 'ADVANCED'],
    ['person-novice.json', 'NOVICE'],
    ['person-technician-plus.json', 'TECHNICIAN PLUS'],
  ])('refuses to promote %s, and keeps what the record said', async (file, raw) => {
    const { deps } = serveFixture(file);
    const result = await lookupCallsign('WV0ZZZ', deps);

    expect(result.status).toBe('found');
    expect(result.record?.operClassRaw).toBe(raw);
    expect(result.record).not.toHaveProperty('operClass');
  });
});

describe('lookupCallsign: addresses', () => {
  it('leaves city, state and zip unset when line2 does not split cleanly', async () => {
    const { deps } = serveFixture('person-unsplittable-address.json');
    const result = await lookupCallsign('AJ0ZZZ', deps);

    expect(result.status).toBe('found');
    // A comma is present and a naive split would set state to "EXAMPLESHIRE". All three or none.
    expect(result.record).not.toHaveProperty('city');
    expect(result.record).not.toHaveProperty('state');
    expect(result.record).not.toHaveProperty('zip');
    // The part that WAS unambiguous survives.
    expect(result.record?.addressLine1).toBe('123 EXAMPLE ST');
  });

  it('handles a record with no address at all, which about 1.3% of them have', async () => {
    const { deps } = serveFixture('person-no-address.json');
    const result = await lookupCallsign('NV0ZZZ', deps);

    expect(result.status).toBe('found');
    expect(result.record).not.toHaveProperty('addressLine1');
    expect(result.record).not.toHaveProperty('city');
    // False here means "no PO box was seen", which for an empty address means nothing was seen.
    expect(result.record?.isPoBox).toBe(false);
  });

  it('keeps an unpunctuated ZIP+4 exactly as it arrived', async () => {
    const { deps } = serve(
      mutate('person-extra.json', (body) => {
        body.address.line2 = 'EXAMPLEVILLE, KS 000000000';
      }),
    );
    const result = await lookupCallsign('WV0ZZZ', deps);

    expect(result.record?.zip).toBe('000000000');
    expect(result.record?.city).toBe('EXAMPLEVILLE');
  });
});

/**
 * THE THREE FIELDS THIS PARSER USED TO STEP OVER, AND THE ONE THING THEY ARE NOT.
 *
 * Every VALID body carries `location: { latitude, longitude, gridsquare }`, and until 2026-08-11
 * this module read none of them. They are NOT a station: callook geocodes the licensee's mailing
 * address, so `01-callook-info-w1mx-json.json` — a collegiate club, which is this product's whole
 * audience — answers with a post office box in Boston stated to eight decimal places, for a club
 * that is at MIT in Cambridge. `types.ts` carries the argument; what is pinned here is that the
 * parse is strict, that a placeholder is not a place, and that the shape a consumer receives cannot
 * be read as a station position without saying out loud that it is a post office.
 */
describe('lookupCallsign: where the mail goes', () => {
  it('reads a street address as a mailing coordinate, not as a station', async () => {
    const { deps } = serveFixture('00-callook-info-w1aw-json.json');
    const result = await lookupCallsign('W1AW', deps);

    expect(result.record?.mailingGeocode).toEqual({
      geocodedFrom: 'street_address',
      mailingAddress: { latitude: 41.714707, longitude: -72.728411, gridsquare: 'FN31pr' },
    });
    // Numbers, from strings. The wire says `"41.714707"`; a consumer doing arithmetic on `"41.7"`
    // gets string concatenation and no error.
    const geocode = result.record?.mailingGeocode;
    expect(geocode?.geocodedFrom).toBe('street_address');
    if (geocode?.geocodedFrom !== 'street_address') throw new Error('narrowing failed');
    expect(typeof geocode.mailingAddress.latitude).toBe('number');
    expect(typeof geocode.mailingAddress.longitude).toBe('number');
  });

  it('files a PO box coordinate as a PO box, so nothing downstream can miss it', async () => {
    const { deps } = serveFixture('01-callook-info-w1mx-json.json');
    const result = await lookupCallsign('W1MX', deps);

    expect(result.record?.isPoBox).toBe(true);
    expect(result.record?.mailingGeocode).toEqual({
      geocodedFrom: 'po_box',
      poBox: { latitude: 42.34991837, longitude: -71.0538559, gridsquare: 'FN42li' },
    });
    // The key IS the warning: there is no `mailingAddress` on this arm to read by accident.
    expect(result.record?.mailingGeocode).not.toHaveProperty('mailingAddress');
  });

  /**
   * A line carrying BOTH a street address and a box is read as a box, which is the cautious half
   * of a question the response does not answer: callook does not say which of the two it geocoded.
   * Labelling a street geocode as a mail drop costs a caveat nobody needed; the other way round
   * costs a radius verdict computed from a post office.
   */
  it('reads a line carrying a street address AND a box as a box', async () => {
    const { deps } = serveFixture('02-callook-info-k2cc-json.json');
    const result = await lookupCallsign('K2CC', deps);

    expect(result.record?.addressLine1).toBe('8 CLARKSON AVE, P.O. BOX 8550');
    expect(result.record?.mailingGeocode).toEqual({
      geocodedFrom: 'po_box',
      poBox: { latitude: 44.66594, longitude: -74.992531, gridsquare: 'FN24mp' },
    });
  });

  /**
   * ONE READING OF ONE LINE. The boolean and the discriminant are computed from the same call, so
   * a record cannot say "this is a mail drop" in one field and "this is not" in the other —
   * whichever a consumer reads, the other cannot contradict it.
   */
  it('never disagrees with its own isPoBox flag, on any fixture', async () => {
    const files = readdirSync(FIXTURES).filter((file) => file.endsWith('.json'));
    expect(files.length).toBeGreaterThan(10);

    for (const file of files) {
      const { deps } = serveFixture(file);
      const { record } = await lookupCallsign('W1MX', deps);
      if (record?.mailingGeocode === undefined) continue;
      expect(record.mailingGeocode.geocodedFrom === 'po_box', file).toBe(record.isPoBox);
    }
  });

  /**
   * THE PLACEHOLDER, WHICH IS THE SHAPE OF AN ANSWER AND NOT ONE.
   *
   * Six hand-built fixtures carry `"0.0" / "0.0" / "JJ00aa"` — null island, in the Gulf of Guinea,
   * measured at 5,334 miles from W1AW's coordinate. A US record cannot geocode there, and
   * `fixtures/callook/README.md` says what the pair is doing in those files: it is a non-key,
   * beside `frn 0000000000` and `licKey=0`.
   *
   * AND A CONSISTENCY CHECK WOULD NOT HAVE CAUGHT IT. `JJ00aa` is the subsquare whose south-west
   * corner IS (0, 0), because it was computed from the zeros — the two agree perfectly. That is
   * why the rule is written down rather than inferred from the locator.
   */
  it.each([
    'person-extra.json',
    'person-general.json',
    'person-technician.json',
    'person-advanced.json',
    'person-novice.json',
    'person-technician-plus.json',
    'person-unsplittable-address.json',
  ])('refuses the 0,0 placeholder in %s rather than putting the Gulf of Guinea in a profile', async (file) => {
    const { deps } = serveFixture(file);
    const result = await lookupCallsign('WV0ZZZ', deps);

    expect(result.status).toBe('found');
    expect(result.record).not.toHaveProperty('mailingGeocode');
  });

  /**
   * ONLY THE PAIR IS THE PLACEHOLDER. A zero on one axis is a statement about the equator or the
   * prime meridian, and refusing it would be this parser ruling on which coordinates are PLAUSIBLE
   * for a US licensee instead of on which values the source stated — the guess it declines to make
   * about a licence class.
   *
   * THE GRID SQUARE MOVES WITH THE COORDINATE HERE, AND IT DID NOT UNTIL 2026-08-11. Both rows used
   * to move the point to the equator or the prime meridian and leave `FN42li` sitting beside it,
   * which was harmless while nothing compared the two and is a self-contradictory record now that
   * `statedPoint` does. Left alone, this test would have gone on passing — the geocode is refused
   * either way — while asserting nothing whatever about a lone zero, which is the assertion it
   * exists to make. So the mutation now writes the locator the coordinate is actually in
   * (`coordinateToLocator` at 6 characters: `FJ40la` and `JN02ai`), and the body is one callook
   * could have sent. The assertion is the one it always was: a zero on one axis is kept.
   */
  it.each([
    [
      'a zero latitude',
      { latitude: '0.0', longitude: '-71.0538559', gridsquare: 'FJ40la' },
      0,
      -71.0538559,
    ],
    [
      'a zero longitude',
      { latitude: '42.34991837', longitude: '0', gridsquare: 'JN02ai' },
      42.34991837,
      0,
    ],
  ])('keeps %s beside a real one', async (_what, edit, latitude, longitude) => {
    const { deps } = serve(
      mutate('01-callook-info-w1mx-json.json', (body) => {
        body.location = { ...edit };
      }),
    );
    const result = await lookupCallsign('W1MX', deps);

    expect(result.record?.mailingGeocode).toEqual({
      geocodedFrom: 'po_box',
      poBox: { latitude, longitude, gridsquare: edit.gridsquare },
    });
  });

  /**
   * WHAT `location` DOES WHEN THERE IS NO ADDRESS — read off the fixture rather than assumed.
   * About 1.3% of records carry no address, and the one in this directory answers the question:
   * the location object is present and all three of its fields are `""`.
   */
  it('gets no coordinate from the ~1.3% of records that carry no address', async () => {
    const body = JSON.parse(loadFixture('callook', 'person-no-address.json')) as CallookBody;
    expect(body.location).toEqual({ latitude: '', longitude: '', gridsquare: '' });

    const { deps } = serveFixture('person-no-address.json');
    const result = await lookupCallsign('NV0ZZZ', deps);

    expect(result.status).toBe('found');
    expect(result.record).not.toHaveProperty('mailingGeocode');
    // AND NO REFUSAL EITHER. Three empty strings is a record that said nothing, and saying "a
    // location was refused" about one would be an over-claim in the other direction — the same
    // mistake as the one `geocodeRefusal` exists to correct, pointed the other way.
    expect(result.record).not.toHaveProperty('geocodeRefusal');
  });

  /**
   * The shape no capture has produced, which is exactly why it is pinned: a coordinate with no
   * address to attribute it to is kept and labelled unattributable, the same division of labour as
   * `operClassRaw` beside an undefined `operClass`. What must never happen is that it arrives
   * looking like a street address the source never showed us.
   */
  it('keeps a coordinate it cannot attribute, and refuses to say what it is of', async () => {
    const { deps } = serve(
      mutate('person-no-address.json', (body) => {
        body.location = { latitude: '41.714707', longitude: '-72.728411', gridsquare: 'FN31pr' };
      }),
    );
    const result = await lookupCallsign('NV0ZZZ', deps);

    expect(result.record?.isPoBox).toBe(false);
    expect(result.record?.mailingGeocode).toEqual({
      geocodedFrom: 'address_not_stated',
      unattributed: { latitude: 41.714707, longitude: -72.728411, gridsquare: 'FN31pr' },
    });
  });

  /**
   * ALL THREE OR NONE, the `CITY_STATE_ZIP` rule applied to the other compound field — plus a
   * reason of its own. The locator is the honest half of the answer: `FN42li` states a box measured
   * at 2.9 by 4.3 miles at Boston's latitude, while `42.34991837` states a millimetre nobody has.
   * Keeping the pair when the locator is unreadable would keep precisely the half that overstates
   * itself.
   *
   * WHAT COUNTS AS UNREADABLE IS CORE'S ANSWER NOW, not a regular expression in `callook.ts`, so
   * the rows below are cases `parseMaidenhead` rejects — an odd length, a character outside its
   * pair's alphabet, a length past eight. THE ROW THAT LEFT THIS LIST was `FN42li07`, labelled "an
   * eight-character extended locator": eight characters are read now, and that row is in the
   * consistency block below under the label it actually earns, because `FN42li07` is not a
   * malformed locator, it is a well-formed one naming a box W1MX's coordinate is not in.
   * `FN42lipr` replaces it as the syntax case, and pins the thing the old comment got wrong: the
   * fourth pair is DIGITS, so a locator with letters there is not an alternative convention, it is
   * not a locator. `FN` is refused for a different reason again — see `MINIMUM_LOCATOR_PRECISION`.
   */
  it.each([
    ['an empty latitude', { latitude: '' }],
    ['an empty longitude', { longitude: '' }],
    ['an empty gridsquare', { gridsquare: '' }],
    ['a latitude past the pole', { latitude: '90.5' }],
    ['a longitude past the meridian', { longitude: '-180.1' }],
    ['a latitude in exponent notation', { latitude: '4.234991837e1' }],
    ['a hexadecimal latitude', { latitude: '0x2A' }],
    ['a latitude with a hemisphere letter', { latitude: '42.34991837N' }],
    ['a latitude that is a word', { latitude: 'Infinity' }],
    ['a latitude of 400 digits', { latitude: '1'.repeat(400) }],
    ['a five-character locator', { gridsquare: 'FN42l' }],
    ['a ten-character locator', { gridsquare: 'FN42li33aa' }],
    ['an extended pair written as letters instead of digits', { gridsquare: 'FN42lipr' }],
    ['a two-character field, too coarse to check anything', { gridsquare: 'FN' }],
    ['a locator with a field letter past R', { gridsquare: 'FZ42li' }],
    ['a locator with a subsquare letter past X', { gridsquare: 'FN42zz' }],
    ['a locator with no square digits', { gridsquare: 'FNxxli' }],
  ])('drops the whole location for %s', async (_what, edit) => {
    const { deps } = serve(
      mutate('01-callook-info-w1mx-json.json', (body) => {
        Object.assign(body.location, edit);
      }),
    );
    const result = await lookupCallsign('W1MX', deps);

    // The rest of the record still arrives: this is one field refused, not a failed lookup.
    expect(result.status, _what).toBe('found');
    expect(result.record?.city, _what).toBe('BOSTON');
    expect(result.record, _what).not.toHaveProperty('mailingGeocode');
  });

  /**
   * A four-character locator is the same statement made coarsely — a bigger box, honestly
   * labelled — so refusing it would throw away a usable coordinate over a technicality.
   */
  it('accepts the coarser four-character locator', async () => {
    const { deps } = serve(
      mutate('01-callook-info-w1mx-json.json', (body) => {
        body.location.gridsquare = 'FN42';
      }),
    );
    const result = await lookupCallsign('W1MX', deps);

    expect(result.record?.mailingGeocode).toEqual({
      geocodedFrom: 'po_box',
      poBox: { latitude: 42.34991837, longitude: -71.0538559, gridsquare: 'FN42' },
    });
  });

  /**
   * EIGHT CHARACTERS, WHICH THIS FILE REFUSED UNTIL 2026-08-11 AND CORE COULD ALREADY READ.
   *
   * `FN42li33` is not a guess about anybody's notation: it is what `coordinateToLocator` returns
   * for W1MX's own stated coordinate at eight characters, so the record's two halves are the same
   * place written to two precisions. The refusal it replaces cost the COORDINATE as well as the
   * locator, because the parse is all-or-nothing — measured against the commit before this one, a
   * body carrying this exact pair produced no `mailingGeocode` at all.
   */
  it('accepts the finer eight-character locator', async () => {
    const { deps } = serve(
      mutate('01-callook-info-w1mx-json.json', (body) => {
        body.location.gridsquare = 'FN42li33';
      }),
    );
    const result = await lookupCallsign('W1MX', deps);

    expect(result.record?.mailingGeocode).toEqual({
      geocodedFrom: 'po_box',
      poBox: { latitude: 42.34991837, longitude: -71.0538559, gridsquare: 'FN42li33' },
    });
  });

  /**
   * Kept exactly as it arrived, for the reason the ZIP keeps its hyphen or its absence: re-casing
   * it would be this software presenting its own tidy-up as something the record said. A locator
   * means the same thing in any case, which is why the odd casing is READ rather than refused.
   */
  it('keeps the locator’s case as the record printed it', async () => {
    const { deps } = serve(
      mutate('01-callook-info-w1mx-json.json', (body) => {
        body.location.gridsquare = 'fn42LI';
      }),
    );
    const result = await lookupCallsign('W1MX', deps);
    const geocode = result.record?.mailingGeocode;
    if (geocode?.geocodedFrom !== 'po_box') throw new Error('expected the PO box arm');

    expect(geocode.poBox.gridsquare).toBe('fn42LI');
  });

  /**
   * THE DESIGN, PINNED AS A FACT ABOUT THE SHAPE.
   *
   * `matcher` decides radius eligibility from a bare latitude and longitude, so a bare latitude and
   * longitude on this record would be one assignment away from a profile — and that assignment
   * prints a confident verdict about somebody's post office. Reaching a coordinate has to go
   * through a discriminant that names what it is a geocode of. This test fails the moment somebody
   * flattens the pair back onto the record "for convenience".
   */
  it.each(['latitude', 'longitude', 'lat', 'lon', 'gridsquare', 'location'])(
    'puts no bare %s on the record itself',
    async (key) => {
      const { deps } = serveFixture('00-callook-info-w1aw-json.json');
      const result = await lookupCallsign('W1AW', deps);

      expect(result.record).toBeDefined();
      expect(result.record).not.toHaveProperty(key);
    },
  );
});

/**
 * THE TWO HALVES CHECK EACH OTHER, WHICH IS THE ONLY REASON BOTH ARE KEPT.
 *
 * `core/maidenhead.ts` was written on 2026-08-11 with `checkCoordinateAgainstLocator` in it, and
 * three separate comment blocks justified carrying a coordinate AND a locator on the ground that
 * each catches the other being wrong. Nothing called it. Measured against the commit before this
 * one, with the probe in the first test below: a record was emitted as a clean `street_address`
 * geocode whose stated point is 5,385 miles from the centre of its own stated square, with no
 * marker of any kind on it.
 *
 * WHAT A CONTRADICTION DOES IS COST THE WHOLE FIELD, and these tests are where that decision is
 * pinned rather than argued. Nothing in the response says which half is wrong, so nothing here can
 * choose one; a marked-inconsistent state would be a state whose every handler says "treat this as
 * absent". The tests below pin both directions of that: a contradictory record yields no geocode
 * on any of the three arms, and — the half that would otherwise rot — a record that AGREES still
 * yields one.
 */
describe('lookupCallsign: a record that contradicts itself', () => {
  /**
   * THE VERIFIER'S OWN PROBE. `FN31pr` is in Connecticut; (10, 10) is in the Atlantic off Liberia,
   * `JK50aa`, 5,385 miles from the centre of the square the same record names.
   */
  it('keeps no coordinate from a point 5,385 miles outside its own stated square', async () => {
    const { deps } = serve(
      mutate('00-callook-info-w1aw-json.json', (body) => {
        body.location = { latitude: '10.0', longitude: '10.0', gridsquare: 'FN31pr' };
      }),
    );
    const result = await lookupCallsign('W1AW', deps);

    expect(result.record).not.toHaveProperty('mailingGeocode');
    // One field refused, not a failed lookup: everything the record said that it did not
    // contradict still arrives, and the person still gets their name and address filled in.
    expect(result.status).toBe('found');
    expect(result.record?.name).toBe('ARRL HQ OPERATORS CLUB');
    expect(result.record?.city).toBe('NEWINGTON');
    expect(result.record?.state).toBe('CT');
  });

  /**
   * AND THE REFUSAL IS ITSELF NEWS, WHICH IS WHAT WAS MISSING.
   *
   * Measured in a browser against a running server on 2026-08-11, before this field existed: this
   * exact body came off the wire as `{"status":"found","record":{…}}` with no `mailingGeocode`
   * key, no server log line, no panel section and no live-region mention — indistinguishable from
   * `person-no-address.json`, whose location is three empty strings. Two different events, one
   * silence, and the panel then asserted that the state was "the only thing kept from these
   * lines" over a record that had also stated a coordinate.
   *
   * WHAT IS NOT REOPENED: the decision that a contradictory record costs the WHOLE field. There is
   * no coordinate on this object, no `MailingGeocode` to narrow, and every exhaustive `switch`
   * downstream is untouched — the argument `readLocation` makes against "mark it and pass it on"
   * was about passing the NUMBERS, and no number is passed.
   */
  it('says WHY it kept nothing, without handing anybody the coordinate', async () => {
    const { deps } = serve(
      mutate('00-callook-info-w1aw-json.json', (body) => {
        body.location = { latitude: '10.0', longitude: '10.0', gridsquare: 'FN31pr' };
      }),
    );
    const result = await lookupCallsign('W1AW', deps);

    expect(result.record?.geocodeRefusal).toEqual({
      refused: 'contradicted',
      gridsquare: 'FN31pr',
      // Core's answer, at the stated locator's own precision — the evidence for the disagreement.
      containingLocator: 'JK50aa',
    });
    expect(result.record).not.toHaveProperty('mailingGeocode');
    // No latitude anywhere on the record, under any key. The reason travels; the numbers do not.
    expect(JSON.stringify(result.record)).not.toContain('latitude');
  });

  /**
   * ONE REASON PER UPSTREAM DEFECT, on the same principle that split `malformed` out of `not_us`:
   * "your record's two halves disagree" and "GrantSpotter could not read the grid square" are
   * different things to be told, and only one of them is a fault in the record.
   */
  it.each([
    [
      'an unreadable locator',
      { gridsquare: 'FN42l' },
      { refused: 'unreadable_locator', gridsquare: 'FN42l' },
    ],
    [
      'a two-character locator, too coarse to check anything against',
      { gridsquare: 'FN' },
      { refused: 'locator_too_coarse', gridsquare: 'FN' },
    ],
    ['a latitude that is not a number', { latitude: '42.34991837N' }, { refused: 'incomplete' }],
    ['half a location', { gridsquare: '' }, { refused: 'incomplete' }],
    [
      'the null-island placeholder',
      { latitude: '0.0', longitude: '0.0', gridsquare: 'JJ00aa' },
      { refused: 'placeholder' },
    ],
  ])('reports %s as its own kind of refusal', async (_what, edit, expected) => {
    const { deps } = serve(
      mutate('01-callook-info-w1mx-json.json', (body) => {
        Object.assign(body.location, edit);
      }),
    );
    const result = await lookupCallsign('W1MX', deps);

    expect(result.record, _what).not.toHaveProperty('mailingGeocode');
    expect(result.record?.geocodeRefusal, _what).toMatchObject(expected);
  });

  /** A record that agrees with itself carries no refusal — the half that would otherwise rot. */
  it('sets no refusal on any of the three real captures', async () => {
    for (const [file, callsign] of [
      ['00-callook-info-w1aw-json.json', 'W1AW'],
      ['01-callook-info-w1mx-json.json', 'W1MX'],
      ['02-callook-info-k2cc-json.json', 'K2CC'],
    ] as const) {
      const { deps } = serveFixture(file);
      const result = await lookupCallsign(callsign, deps);
      expect(result.record?.mailingGeocode, file).toBeDefined();
      expect(result.record, file).not.toHaveProperty('geocodeRefusal');
    }
  });

  /**
   * ON EVERY ARM, because the refusal is in the parse and not in one branch of the attribution. A
   * contradiction that survived on the `po_box` arm would survive on the records this product is
   * for: two of the three real captures are collegiate clubs at a PO box.
   */
  it.each([
    ['a street address', '00-callook-info-w1aw-json.json', 'W1AW'],
    ['a PO box', '01-callook-info-w1mx-json.json', 'W1MX'],
    ['no address at all', 'person-no-address.json', 'NV0ZZZ'],
  ])('refuses it when the address is %s', async (_what, file, callsign) => {
    const { deps } = serve(
      mutate(file, (body) => {
        body.location = { latitude: '10.0', longitude: '10.0', gridsquare: 'FN31pr' };
      }),
    );
    const result = await lookupCallsign(callsign, deps);

    expect(result.status, _what).toBe('found');
    expect(result.record, _what).not.toHaveProperty('mailingGeocode');
  });

  /**
   * A NEAR MISS IS STILL A MISS. `FN42li07` is a well-formed eight-character locator — the very
   * string this file used to refuse as unreadable — naming a box that W1MX's coordinate misses by
   * 0.0126° of latitude, which is 0.87 miles measured with `haversineMiles`. Small enough to
   * change no radius verdict in this corpus, and still two statements computed from different data,
   * which is the thing being detected. The check is about a record agreeing with itself, not about
   * a distance being large enough to matter — a threshold in miles would be this file inventing a
   * tolerance the source never published.
   */
  it('refuses a well-formed locator that misses by 0.87 miles', async () => {
    const { deps } = serve(
      mutate('01-callook-info-w1mx-json.json', (body) => {
        body.location.gridsquare = 'FN42li07';
      }),
    );
    const result = await lookupCallsign('W1MX', deps);

    expect(result.record?.city).toBe('BOSTON');
    expect(result.record).not.toHaveProperty('mailingGeocode');
  });

  /**
   * A MISS OF EXACTLY ZERO IS NOT A DISAGREEMENT, AND THIS IS THE ONE EXCEPTION.
   *
   * 42.375 is `FN42li`'s north edge exactly. Core's boxes are half-open, so the point belongs to
   * `FN42lj` and the answer is `outside` — with both offsets 0, which is what "on the line" looks
   * like. Two implementations that disagree about which side of a boundary owns a point on it are
   * not disagreeing about where the station is, and a coordinate rounded to eight places lands
   * exactly there: 42.374999996 inside the box prints as 42.375 on its edge.
   */
  it('keeps a coordinate sitting exactly on its own square’s edge', async () => {
    const { deps } = serve(
      mutate('01-callook-info-w1mx-json.json', (body) => {
        body.location.latitude = '42.375';
      }),
    );
    const result = await lookupCallsign('W1MX', deps);

    expect(result.record?.mailingGeocode).toEqual({
      geocodedFrom: 'po_box',
      poBox: { latitude: 42.375, longitude: -71.0538559, gridsquare: 'FN42li' },
    });
  });

  /**
   * AND THE EXCEPTION IS EXACTLY THAT NARROW. One ten-millionth of a degree past the edge — 1.1 cm
   * — is refused, and that is deliberate rather than an oversight in a tolerance. There is no
   * tolerance: a geocoder that computed this locator FROM this coordinate would have named the box
   * above, under either edge convention, so a point past the line was not computed from the same
   * data. Nothing rounds to 1.1 cm outside a boundary; things round ONTO it, which is the case
   * above.
   */
  it('refuses a coordinate 1.1 cm past that edge', async () => {
    const { deps } = serve(
      mutate('01-callook-info-w1mx-json.json', (body) => {
        body.location.latitude = '42.3750001';
      }),
    );
    const result = await lookupCallsign('W1MX', deps);

    expect(result.record).not.toHaveProperty('mailingGeocode');
  });

  /**
   * THE INVARIANT `types.ts` NOW PROMISES A CONSUMER, checked against every fixture rather than
   * asserted in prose: if a record carries a `mailingGeocode` at all, its point is in its own
   * locator's box or exactly on that box's edge. This is also the guard that stops the rule above
   * from being satisfied by refusing everything — three real captures still produce a geocode.
   */
  it('emits no geocode whose two halves disagree, on any fixture', async () => {
    const files = readdirSync(FIXTURES).filter((file) => file.endsWith('.json'));
    let kept = 0;

    for (const file of files) {
      const { deps } = serveFixture(file);
      const { record } = await lookupCallsign('W1MX', deps);
      if (record?.mailingGeocode === undefined) continue;
      kept += 1;
      const point = statedPointOf(record.mailingGeocode);
      const agreement = checkCoordinateAgainstLocator(
        point.latitude,
        point.longitude,
        point.gridsquare,
      );
      if (agreement.status === 'outside') {
        // Reported rather than folded into the boolean: a failure here should say how far out.
        expect([file, agreement.latOffsetDeg, agreement.lonOffsetDeg]).toEqual([file, 0, 0]);
      } else {
        expect(agreement.status, file).toBe('inside');
      }
    }

    // W1AW, W1MX and K2CC. The hand-built fixtures all carry the 0,0 placeholder and keep nothing.
    expect(kept).toBe(3);
  });
});

describe('lookupCallsign: the answers that are not a record', () => {
  it('reports INVALID as "no record", in words that do not tell a licensee they are unlicensed', async () => {
    const { deps, calls } = serveFixture('03-callook-info-al0zzz-json.json');
    const result = await lookupCallsign('AL0ZZZ', deps);

    expect(result.status).toBe('not_found');
    expect(result.record).toBeUndefined();
    expect(result.message).toContain('AL0ZZZ');
    expect(result.message).toContain('typo');
    expect(result.message).toMatch(/type your details in/i);
    expect(calls).toHaveLength(1);
  });

  it('never reports the daily import as "not found"', async () => {
    const { deps } = serveFixture('updating.json');
    const result = await lookupCallsign('W1AW', deps);

    expect(result.status).toBe('updating');
    expect(result.record).toBeUndefined();
    expect(result.message).toMatch(/try again/i);
    expect(result.message).not.toMatch(/not found|no record|invalid/i);
  });

  it('short-circuits a non-US callsign BEFORE any request', async () => {
    const { deps, calls } = serveFixture('03-callook-info-al0zzz-json.json');
    const result = await lookupCallsign('ZS6ABC', deps);

    expect(result.status).toBe('not_us');
    // The whole point: a German or South African licensee is never told "not found", because at
    // account creation that reads as "your licence is invalid".
    expect(calls).toHaveLength(0);
    expect(result.message).toMatch(/United States/);
    expect(result.message).toMatch(/type your licence details in/i);
    expect(result.message).not.toMatch(/not found|invalid/i);
  });

  it('does not quote a pasted paragraph back at the person who pasted it', async () => {
    const { deps, calls } = serveFixture('00-callook-info-w1aw-json.json');
    const result = await lookupCallsign('W1AW '.repeat(400), deps);

    // `not_us` until 2026-08-09. Four hundred callsigns run together is not a foreign licence; the
    // clipping is what this test is about and it is asserted on the message that is now correct.
    expect(result.status).toBe('malformed');
    expect(calls).toHaveLength(0);
    expect(result.message?.length).toBeLessThan(600);
  });

  it.each(['G0ABC', 'JA1XYZ', 'VE3ABC'])('makes no request at all for %s', async (input) => {
    const { deps, calls } = serveFixture('00-callook-info-w1aw-json.json');
    const result = await lookupCallsign(input, deps);

    expect(result.status).toBe('not_us');
    expect(calls).toHaveLength(0);
  });

  /**
   * THE FOUR INPUTS THIS TABLE USED TO ASSERT `not_us` FOR, WHICH WAS WRONG ABOUT ALL FOUR.
   *
   * `''`, `'???'`, `'W1AW/4'` and `'../../etc/passwd'` sat in the list above beside three genuine
   * foreign callsigns, and the assertion said the product told all seven the same thing. It did:
   * "GrantSpotter can only look up United States callsigns automatically… your licence is no less
   * valid for being issued somewhere this lookup cannot reach", printed over an empty box, over
   * punctuation, and over a US callsign with an operating suffix on it. The request count was the
   * property worth pinning and it still is, so it is asserted here unchanged — what changes is the
   * status, because the old one was the defect written down as an expectation.
   */
  it.each(['', '   ', '???', 'W1AW/4', '../../etc/passwd', 'N0CALLXX', 'W5X5', 'KANSAS'])(
    'makes no request for %s either, and does not call it foreign',
    async (input) => {
      const { deps, calls } = serveFixture('00-callook-info-w1aw-json.json');
      const result = await lookupCallsign(input, deps);

      expect(result.status).toBe('malformed');
      expect(calls).toHaveLength(0);
      expect(wouldReachTheSource(input, deps)).toBe(false);
    },
  );

  /**
   * THE REPORT, IN ONE TEST. `N0` is a US prefix and `N0CALLXX` has six suffix letters where the
   * format allows four, so it is a typo — and it was answered with the paragraph written to
   * reassure international operators, which told an American their callsign was not American.
   */
  it('tells somebody who mistyped a US callsign that it is a typo, not a foreign licence', async () => {
    const { deps, calls } = serveFixture('00-callook-info-w1aw-json.json');
    const result = await lookupCallsign('N0CALLXX', deps);

    expect(result.status).toBe('malformed');
    expect(calls).toHaveLength(0);
    expect(result.record).toBeUndefined();
    // What it says: we could not read this, check it.
    expect(result.message).toContain('N0CALLXX');
    expect(result.message).toMatch(/could not read/i);
    expect(result.message).toMatch(/check what you typed/i);
    // What it must not say: anything at all about which country issued the licence…
    expect(result.message).not.toMatch(/United States|not a US|foreign|issued somewhere/i);
    // …and nothing that reads as a verdict on the licence itself.
    expect(result.message).not.toMatch(/not found|invalid|unlicensed/i);
  });

  it('still says "not a US callsign" to a callsign that really is somebody else’s', async () => {
    const { deps, calls } = serveFixture('00-callook-info-w1aw-json.json');
    const result = await lookupCallsign('G0ABC', deps);

    expect(result.status).toBe('not_us');
    expect(calls).toHaveLength(0);
    expect(result.message).toMatch(/United States/);
    // The reassurance the split exists to keep pointed at the people it was written for.
    expect(result.message).toMatch(/no less valid/i);
    expect(result.message).not.toMatch(/not found|invalid/i);
  });
});

describe('lookupCallsign: failures', () => {
  it('refuses a blocked host without asking it anything', async () => {
    const { deps, calls } = serveFixture('00-callook-info-w1aw-json.json');
    const result = await lookupCallsign('W1AW', { ...deps, baseUrl: 'https://farweb.org' });

    expect(result.status).toBe('unavailable');
    expect(calls).toHaveLength(0);
    expect(result.message).toMatch(/setting on this server, not a problem with your callsign/);
    expect(result.message).toContain('farweb.org');
  });

  it('gives up on a timeout instead of doubling the wait', async () => {
    const calls: RequestInit[] = [];
    const deps: CallsignLookupDeps = {
      timeoutMs: 20,
      cooldown: createHostCooldown(),
      transport: (_url, init) => {
        calls.push(init);
        return new Promise<Response>((_resolve, reject) => {
          const signal = init.signal;
          // Fail fast rather than hanging, so a dropped signal is a red test and not a stuck one.
          if (!signal) reject(new Error('no abort signal was passed to the transport'));
          else signal.addEventListener('abort', () => reject(signal.reason));
        });
      },
    };
    const result = await lookupCallsign('W1AW', deps);

    expect(result.status).toBe('unavailable');
    expect(calls).toHaveLength(1);
    expect(result.message).toMatch(/did not answer in time/);
    expect(result.message).toMatch(/not anything to do with your callsign/);
  });

  /**
   * TWO ASSERTIONS CHANGED HERE ON 2026-08-04, AND WHY THEY WERE WRONG.
   *
   * They were `retries a dropped connection exactly once` (asserting `attempts === 2` and a
   * `found` result reached on the second try) and `never makes a third attempt` (asserting
   * `attempts === 2`). Both were faithful descriptions of what the code did. What made them wrong
   * is that the code contradicted two published sentences at once:
   *
   *   - `callook.ts`'s own timeout comment — "the worst case a user can experience is this budget
   *     once" — while each attempt got a FRESH `AbortSignal.timeout(timeoutMs)`. Measured against
   *     a loopback server that accepted and then destroyed the socket at 900 ms with a 1000 ms
   *     budget: 2 requests, 1808 ms.
   *   - `api/callsign.ts`'s rate-limit comment — "one press of this button is one request to
   *     somebody else's server" — which is also the sentence the README uses to justify querying a
   *     host that publishes `Disallow: /` at all. A feature defended in public as "one
   *     user-initiated request" may not quietly send two.
   *
   * So the promises stayed and the retry went. The assertions below are strictly STRONGER than the
   * ones they replace — one attempt is a subset of at most two — and they are the ones the
   * documents can be checked against.
   */
  it('does not retry a dropped connection: one press is one request', async () => {
    let attempts = 0;
    const deps: CallsignLookupDeps = {
      now: () => Date.parse(AT),
      cooldown: createHostCooldown(),
      transport: () => {
        attempts += 1;
        // A second attempt WOULD have succeeded. That is the point: the old code took it, and
        // the cost of taking it was a second request to a host that had just dropped the first.
        if (attempts === 1) return Promise.reject(new Error('ECONNRESET'));
        return Promise.resolve(new Response(loadFixture('callook', 'person-extra.json')));
      },
    };
    const result = await lookupCallsign('WV0ZZZ', deps);

    expect(attempts).toBe(1);
    expect(result.status).toBe('unavailable');
    expect(result.message).toMatch(/could not reach callook\.info/);
    expect(result.message).toMatch(/not your callsign/);
    // The retry is the person's to make, and the message has to offer it.
    expect(result.message).toMatch(/try again in a moment/);
  });

  it('spends one timeout budget per call, not one per attempt', async () => {
    // Pins the mechanism rather than the wall clock: a fake timer would make an elapsed-time
    // assertion pass against code that still minted a second signal, and a real one would make
    // this test take a second and fail on a loaded machine.
    const signals: unknown[] = [];
    const deps: CallsignLookupDeps = {
      timeoutMs: 1_000,
      cooldown: createHostCooldown(),
      transport: (_url, init) => {
        signals.push(init.signal);
        return Promise.reject(new Error('ECONNRESET'));
      },
    };
    const result = await lookupCallsign('W1AW', deps);

    expect(signals).toHaveLength(1);
    expect(result.status).toBe('unavailable');
  });

  /**
   * A BARE 503 IS TROUBLE, NOT AN INSTRUCTION, and that is why this case still reads the way it
   * always did while the 429 case below no longer does. "Service unavailable" with no `Retry-After`
   * says the source is having a bad minute; it does not say when to come back, and inventing a
   * number and calling it "callook.info asked us to wait" would be this module attributing an
   * instruction to a source that gave none — which is the one thing this product does not do.
   * The 503 that DOES carry a header is handled with the 429s, where it belongs.
   */
  it('reports an HTTP status as the source having trouble', async () => {
    const { deps, calls } = serve('<html>503</html>', { status: 503 });
    const result = await lookupCallsign('W1AW', deps);

    expect(result.status).toBe('unavailable');
    expect(result.message).toContain('503');
    // The sentence that is TRUE of a 5xx, and which the redirect case below no longer borrows.
    expect(result.message).toMatch(/source having trouble/);
    // Still no retry on a status, and now no second request on the NEXT press either when the
    // source asked for one — see the cooldown block below.
    expect(calls).toHaveLength(1);
  });

  /**
   * A REDIRECT IS OUR DECISION, AND THE MESSAGE SAYS SO SINCE 2026-08-04.
   *
   * It used to fall into the status message above and read "callook.info answered with HTTP 301
   * instead of a licence record… That is the source having trouble". A 301 is not trouble: it is a
   * good answer meaning "it is over here", and the only reason the lookup ends there is that this
   * client sets `redirect: 'manual'` ON PURPOSE, because following one would request a host that
   * has never been past `assertNotBlocked` and would make "one press, one request, one host" false.
   * Blaming a source for a rule of ours is the same class of mistake as attributing an unread body
   * to it, which this module already refuses to make.
   */
  it.each([301, 302, 307, 308])('does not follow a %d, and does not blame the source for it', async (status) => {
    const { deps, calls } = serve('', {
      status,
      headers: { location: 'https://example.invalid/W1AW/json' },
    });
    const result = await lookupCallsign('W1AW', deps);

    expect(result.status).toBe('unavailable');
    expect(calls).toHaveLength(1);
    expect(result.message).toContain(`redirect (HTTP ${String(status)})`);
    expect(result.message).toMatch(/rule of GrantSpotter/);
    expect(result.message).toMatch(/nothing is wrong with your callsign/i);
    // The two claims that were false. It answered; it is not having trouble.
    expect(result.message).not.toMatch(/source having trouble/);
    expect(result.message).not.toMatch(/instead of a licence record/);
    // And the destination is not quoted at a person who has no use for it.
    expect(result.message).not.toContain('example.invalid');
  });

  it.each([
    ['a truncated body', '{"status": "VALID", "type": "PER'],
    ['HTML from a captive portal', '<html><body>Sign in to continue</body></html>'],
    ['an empty body', ''],
    ['a JSON array', '[]'],
    ['no status field', '{"type": "PERSON", "name": "ALEX Q EXAMPLE"}'],
    ['an unknown status', '{"status": "MAYBE"}'],
  ])('treats %s as unavailable, never as "not found"', async (_what, body) => {
    const { deps } = serve(body);
    const result = await lookupCallsign('W1AW', deps);

    expect(result.status).toBe('unavailable');
    expect(result.record).toBeUndefined();
    expect(result.message).toMatch(/ours to fix, not yours/);
  });

  it('refuses a VALID body with no name rather than inventing one', async () => {
    const { deps } = serve(mutate('person-extra.json', (body) => { body.name = ''; }));
    const result = await lookupCallsign('WV0ZZZ', deps);

    expect(result.status).toBe('unavailable');
    expect(result.record).toBeUndefined();
  });

  it('refuses a VALID body with no callsign rather than echoing the query back', async () => {
    const { deps } = serve(mutate('person-extra.json', (body) => { body.current.callsign = ''; }));
    const result = await lookupCallsign('WV0ZZZ', deps);

    expect(result.status).toBe('unavailable');
    expect(result.record).toBeUndefined();
  });

  it('refuses a licensee type it does not know instead of filing it under the nearest one', async () => {
    const { deps } = serve(mutate('person-extra.json', (body) => { body.type = 'PARTNERSHIP'; }));
    const result = await lookupCallsign('WV0ZZZ', deps);

    expect(result.status).toBe('unavailable');
    expect(result.message).toContain('PARTNERSHIP');
  });

  it.each(['MILITARY', 'RACES', 'RECREATION'])(
    'reads %s as an organisational licence, the same shape as a club',
    async (type) => {
      const { deps } = serve(mutate('person-extra.json', (body) => { body.type = type; }));
      const result = await lookupCallsign('WV0ZZZ', deps);

      expect(result.record?.type).toBe('CLUB');
    },
  );
});

/**
 * WHAT A SOURCE ASKING TO BE LEFT ALONE COSTS IT, MEASURED IN REQUESTS.
 *
 * Before this block existed, a stand-in answering `429 Retry-After: 120` to everything received
 * EIGHT requests in 69 ms from eight presses — consecutive gaps of 21, 9, 7, 8, 8, 8 and 8 ms. The
 * rate limiter next door allows eight presses per ten minutes and cannot see how fast they arrive.
 * The host being hammered was the one whose robots.txt says `Disallow: /`, which this product
 * queries anyway on an argument that rests entirely on this being one request a person asked for.
 *
 * WHY THE ANSWER IS `unavailable` AND NOT A STATUS OF ITS OWN, WHICH IS STILL TRUE NOW THAT
 * `malformed` EXISTS. Every ending `unavailable` covers shares one frame that is true of all of
 * them — no record, nothing filled in, nothing claimed about the callsign — so the status costs the
 * reader nothing and the server's sentence says which ending it was. `malformed` was added on
 * 2026-08-09 because its cases had NO true frame to share: they were arriving as `not_us`, whose
 * frame states in a heading that the callsign is not American, which is a claim and was false. A
 * status earns its place when the frame would otherwise lie, not when the sentence differs.
 *
 * Adding one is not free either way: `packages/web` holds a runtime `KNOWN_STATUSES` guard, and a
 * status it does not know is reported as "the API answered with something that is not a lookup
 * result… a proxy, tunnel, or sign-in page may have answered instead". Anything added here has to
 * be added there in the same change, or the politest outcome in the product renders as the most
 * alarming one.
 */
describe('lookupCallsign: when the source asks us to wait', () => {
  interface WaitHarness {
    deps: CallsignLookupDeps;
    /** The clock reading at each request the transport actually received. */
    calls: number[];
    clock: { ms: number };
  }

  function stubbornSource(init: {
    status: number;
    headers?: Record<string, string>;
    baseUrl?: string;
    cooldown?: ReturnType<typeof createHostCooldown>;
  }): WaitHarness {
    const clock = { ms: Date.parse(AT) };
    const calls: number[] = [];
    return {
      clock,
      calls,
      deps: {
        now: () => clock.ms,
        cooldown: init.cooldown ?? createHostCooldown(),
        ...(init.baseUrl === undefined ? {} : { baseUrl: init.baseUrl }),
        transport: () => {
          calls.push(clock.ms);
          return Promise.resolve(
            new Response('slow down', { status: init.status, headers: init.headers ?? {} }),
          );
        },
      },
    };
  }

  /** Eight presses, as fast as the code will go, which is what a person leaning on a button is. */
  async function press(harness: WaitHarness, times: number): Promise<string[]> {
    const messages: string[] = [];
    for (let i = 0; i < times; i += 1) {
      const result = await lookupCallsign('W1AW', harness.deps);
      messages.push(result.message ?? '');
    }
    return messages;
  }

  /**
   * The same presses OVERLAPPING rather than queued, which is what two people are — and what one
   * person with two tabs is. `press` above waits for each answer before making the next press, so
   * every one of its presses reads a ledger the previous answer has already written to. That is the
   * friendly case, and it was the only one measured until 2026-08-04.
   */
  function pressTogether(harness: WaitHarness, times: number): Promise<string[]> {
    return Promise.all(
      Array.from({ length: times }, async () => (await lookupCallsign('W1AW', harness.deps)).message ?? ''),
    );
  }

  it('turns eight presses at a 429 into ONE request', async () => {
    const harness = stubbornSource({ status: 429, headers: { 'retry-after': '120' } });
    const messages = await press(harness, 8);

    // The whole of the defect, in one number. It was eight.
    expect(harness.calls).toHaveLength(1);
    // …and the seven that made no request still got an answer, not an error.
    expect(messages).toHaveLength(8);
    for (const message of messages) expect(message).toMatch(/asked GrantSpotter to wait/);
    expect(messages[0]).toMatch(/nothing was filled in this time/);
    expect(messages[7]).toMatch(/no request was sent this time/);
  });

  /**
   * THE SAME NUMBER, FOR PRESSES THAT DO NOT WAIT THEIR TURN.
   *
   * Measured 2026-08-04 with the cooldown in place and every test above it green: eight presses
   * fired with `Promise.all` at a stand-in answering `429 Retry-After: 120` produced EIGHT
   * requests. `refuseBeforeRequest` reads the hold before the `await` on the transport and
   * `cooldown.hold` writes it after the response arrives, so every press that starts inside that
   * window passes a check that the press already in flight is about to make false.
   */
  it('turns eight SIMULTANEOUS presses at a 429 into ONE request', async () => {
    const harness = stubbornSource({ status: 429, headers: { 'retry-after': '120' } });
    const messages = await pressTogether(harness, 8);

    // The whole of the defect, in one number. It was eight.
    expect(harness.calls).toHaveLength(1);
    expect(messages).toHaveLength(8);
    // One press asked and was told to wait; the other seven were told, truthfully, that this
    // product was already waiting on an answer — never that the source had refused them anything.
    expect(messages.filter((m) => /asked GrantSpotter to wait/.test(m))).toHaveLength(1);
    expect(messages.filter((m) => /already waiting on an answer/.test(m))).toHaveLength(7);
    for (const message of messages) expect(message).toMatch(/nothing is wrong with your callsign/i);
  });

  /**
   * The lane on its own, with no hold to hide behind: a 200 arms nothing, so ONE request here is
   * the lane and nothing else. Seven presses at a healthy source are still refused, and that cost
   * is the point rather than an accident — one button, one source, one question at a time.
   */
  it('sends one request for eight simultaneous presses even when the source is perfectly happy', async () => {
    const harness = stubbornSource({ status: 200 });
    const messages = await pressTogether(harness, 8);

    expect(harness.calls).toHaveLength(1);
    expect(messages.filter((m) => /already waiting on an answer/.test(m))).toHaveLength(7);
    // A press refused for our own reason says so, and does not describe the source at all.
    const refused = messages.find((m) => /already waiting on an answer/.test(m)) ?? '';
    expect(refused).toMatch(/rule of GrantSpotter/);
    expect(refused).not.toMatch(/could not|failed|error|trouble|slow/i);
  });

  /** The lane is a moment, not a switch-off: the press after the answer asks again. */
  it('gives the lane back the moment the answer lands', async () => {
    const harness = stubbornSource({ status: 200 });

    await pressTogether(harness, 4);
    expect(harness.calls).toHaveLength(1);

    await press(harness, 1);
    expect(harness.calls).toHaveLength(2);
  });

  /**
   * A lane never given back is this fix becoming a worse outage than the defect it closes: every
   * later press for the life of the process would be answered "already asking".
   */
  it('gives the lane back when the request fails, and not only when it succeeds', async () => {
    let attempts = 0;
    const deps: CallsignLookupDeps = {
      now: () => Date.parse(AT),
      cooldown: createHostCooldown(),
      transport: () => {
        attempts += 1;
        return Promise.reject(new Error('ECONNRESET'));
      },
    };

    const first = await lookupCallsign('W1AW', deps);
    const second = await lookupCallsign('W1AW', deps);

    expect(attempts).toBe(2);
    for (const result of [first, second]) {
      expect(result.message).toMatch(/could not reach callook\.info/);
      expect(result.message).not.toMatch(/already waiting on an answer/);
    }
  });

  /** One lane per HOST. Two stand-ins are two sources, and neither waits for the other. */
  it('holds a lane per host rather than one for the whole process', async () => {
    const cooldown = createHostCooldown();
    const first = stubbornSource({ status: 200, baseUrl: 'http://127.0.0.1:8081', cooldown });
    const second = stubbornSource({ status: 200, baseUrl: 'http://127.0.0.1:8082', cooldown });

    await Promise.all([pressTogether(first, 4), pressTogether(second, 4)]);

    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(1);
  });

  /**
   * THE HALF THE PERSON FEELS, for the lane rather than for the hold. `api/callsign.ts` charges a
   * press only when it would cost callook.info a request, and losing a race costs it nothing.
   */
  it('reports through wouldReachTheSource that a press during a request in flight costs nothing', async () => {
    let answer: (response: Response) => void = () => undefined;
    const deps: CallsignLookupDeps = {
      now: () => Date.parse(AT),
      cooldown: createHostCooldown(),
      transport: () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    };

    expect(wouldReachTheSource('W1AW', deps)).toBe(true);
    const inFlight = lookupCallsign('W1AW', deps);
    // Claimed synchronously, before the first `await` — which is what lets the route ask this
    // question and act on the answer with nothing able to run in between.
    expect(wouldReachTheSource('W1AW', deps)).toBe(false);

    answer(new Response(loadFixture('callook', '00-callook-info-w1aw-json.json'), { status: 200 }));
    expect((await inFlight).status).toBe('found');
    expect(wouldReachTheSource('W1AW', deps)).toBe(true);
  });

  it('says how long, in words a person can act on, and blames nobody', async () => {
    const harness = stubbornSource({ status: 429, headers: { 'retry-after': '120' } });
    const [first] = await press(harness, 1);

    expect(first).toContain('about 2 minutes');
    expect(first).toMatch(/nothing is wrong with your callsign/i);
    expect(first).toMatch(/nothing is wrong with the source/i);
    // Not a failure report: no HTTP status, no "could not", no "error".
    expect(first).not.toContain('429');
    expect(first).not.toMatch(/could not|failed|error|trouble/i);
  });

  it.each([
    ['Retry-After: 0', { 'retry-after': '0' }, 'about 1 minute'],
    ['Retry-After: 1', { 'retry-after': '1' }, 'about 1 minute'],
    ['no Retry-After at all', {}, 'about 1 minute'],
    ['an unparseable Retry-After', { 'retry-after': 'when we feel like it' }, 'about 1 minute'],
    ['Retry-After: 120', { 'retry-after': '120' }, 'about 2 minutes'],
    ['a Retry-After beyond the cap', { 'retry-after': '9999999' }, 'about 24 hours'],
  ])('holds after a 429 with %s', async (_what, headers, expected) => {
    const harness = stubbornSource({ status: 429, headers });
    const messages = await press(harness, 8);

    expect(harness.calls, _what).toHaveLength(1);
    expect(messages[0], _what).toContain(expected);
  });

  it('reads a Retry-After given as a date', async () => {
    const at = Date.parse(AT);
    const harness = stubbornSource({
      status: 429,
      headers: { 'retry-after': new Date(at + 300_000).toUTCString() },
    });
    const messages = await press(harness, 4);

    expect(harness.calls).toHaveLength(1);
    expect(messages[0]).toContain('about 5 minutes');
  });

  /**
   * The hold is a wait, not a switch-off. The feature has to come back on its own, or the first 429
   * a deployment ever sees would end the lookup until somebody restarted the container.
   */
  it('asks again once the wait the source named has run out, and not one moment before', async () => {
    const harness = stubbornSource({ status: 429, headers: { 'retry-after': '120' } });
    await press(harness, 1);
    expect(harness.calls).toHaveLength(1);

    harness.clock.ms += 119_999;
    await press(harness, 1);
    expect(harness.calls).toHaveLength(1);

    harness.clock.ms += 1;
    await press(harness, 1);
    expect(harness.calls).toHaveLength(2);
    // …and the second 429 re-arms it rather than leaving the door open.
    await press(harness, 3);
    expect(harness.calls).toHaveLength(2);
  });

  it('holds after a 503 that names a Retry-After, because that one did say when', async () => {
    const harness = stubbornSource({ status: 503, headers: { 'retry-after': '300' } });
    const messages = await press(harness, 5);

    expect(harness.calls).toHaveLength(1);
    expect(messages[0]).toContain('about 5 minutes');
    expect(messages[0]).not.toContain('503');
  });

  /**
   * The line is drawn at the HEADER, not at the status. A bare 503 has told us it is broken, which
   * is not the same as telling us when to come back, and this module does not invent the second
   * from the first. Five presses are therefore five requests — bounded by the ration next door,
   * which is the mechanism that exists for "the source is failing", not by a hold nobody asked for.
   */
  it('does not invent a wait from a 503 that named none', async () => {
    const harness = stubbornSource({ status: 503 });
    const messages = await press(harness, 5);

    expect(harness.calls).toHaveLength(5);
    expect(messages[0]).toContain('503');
    expect(messages[0]).not.toMatch(/asked GrantSpotter to wait/);
  });

  /** Every other status is unchanged: a 404 or a 500 is not an instruction either. */
  it.each([301, 404, 418, 500])('does not hold on HTTP %d', async (status) => {
    const harness = stubbornSource({ status, headers: { 'retry-after': '120' } });
    await press(harness, 3);

    expect(harness.calls).toHaveLength(3);
  });

  /**
   * A HOLD IS ABOUT THE HOST, NOT ABOUT THE PRODUCT. Two deployments pointed at two different
   * services must not silence each other, and — the case that actually matters — the loopback
   * servers this repo measures against are separate sources rather than one.
   */
  it('holds the host that asked, and no other', async () => {
    const cooldown = createHostCooldown();
    const asked = stubbornSource({
      status: 429,
      headers: { 'retry-after': '120' },
      baseUrl: 'http://127.0.0.1:8081',
      cooldown,
    });
    const other = stubbornSource({
      status: 200,
      baseUrl: 'http://127.0.0.1:8082',
      cooldown,
    });

    await press(asked, 4);
    expect(asked.calls).toHaveLength(1);

    await press(other, 2);
    expect(other.calls).toHaveLength(2);
  });

  /**
   * THE HALF THE PERSON FEELS. `api/callsign.ts` charges a press against the caller's allowance
   * only when it would cost callook.info a request, and it asks THIS function. Eight presses during
   * a two-minute hold must not leave a member with no allowance left and nothing filled in.
   */
  it('reports through wouldReachTheSource that a press during a hold costs the source nothing', async () => {
    const harness = stubbornSource({ status: 429, headers: { 'retry-after': '120' } });

    expect(wouldReachTheSource('W1AW', harness.deps)).toBe(true);
    await press(harness, 1);
    expect(wouldReachTheSource('W1AW', harness.deps)).toBe(false);

    harness.clock.ms += 120_000;
    expect(wouldReachTheSource('W1AW', harness.deps)).toBe(true);
  });

  it('agrees with itself about a blocked host and a foreign callsign', async () => {
    const harness = stubbornSource({ status: 200 });

    expect(wouldReachTheSource('DL1ABC', harness.deps)).toBe(false);
    expect(
      wouldReachTheSource('W1AW', { ...harness.deps, baseUrl: 'https://farweb.org' }),
    ).toBe(false);
  });

  /** The floor is not a second's stutter: it is what stops a burst when the header says nothing. */
  it('never holds for less than the published floor', async () => {
    const harness = stubbornSource({ status: 429, headers: { 'retry-after': '0' } });
    await press(harness, 1);

    harness.clock.ms += COOLDOWN_FLOOR_MS - 1;
    await press(harness, 1);
    expect(harness.calls).toHaveLength(1);

    harness.clock.ms += 1;
    await press(harness, 1);
    expect(harness.calls).toHaveLength(2);
  });
});

/**
 * OUR FAILURE IS NOT THE SOURCE'S STATEMENT.
 *
 * `JSON.parse(await response.text())` used to sit inside one bare `catch {}`, so a timeout or a
 * dropped socket during the BODY READ came out as "callook.info answered with something we could
 * not read as a licence record". Nothing had been answered with anything: the bytes never arrived.
 * This product's whole discipline is not attributing to a source something it did not say, and an
 * error message is not exempt — a user reading that sentence, or a maintainer reading it in a bug
 * report, is being told callook.info served rubbish when the truth is that we never heard it.
 */
describe('lookupCallsign: which end the failure happened at', () => {
  function bodyThatFails(reject: () => Error): CallsignLookupDeps {
    return {
      now: () => Date.parse(AT),
      cooldown: createHostCooldown(),
      transport: () =>
        Promise.resolve(
          // A Response whose body rejects mid-read is what a socket dying after the headers looks
          // like. `Response.text()` on this stream rejects rather than resolving short.
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"status": "VA'));
                controller.error(reject());
              },
            }),
            { status: 200 },
          ),
        ),
    };
  }

  it('says the connection dropped mid-answer, and claims nothing about what was in it', async () => {
    const result = await lookupCallsign('W1AW', bodyThatFails(() => new Error('ECONNRESET')));

    expect(result.status).toBe('unavailable');
    expect(result.message).toMatch(/dropped while its answer was still arriving/);
    expect(result.message).toMatch(/not known and has not been guessed at/);
    // The sentence that was wrong: it says callook.info SAID something unreadable.
    expect(result.message).not.toMatch(/answered with something we could not read/);
    expect(result.message).toMatch(/not your callsign/);
  });

  it('says the answer ran out of time, and still claims nothing about what was in it', async () => {
    const timeout = (): Error => {
      const error = new Error('The operation was aborted due to timeout');
      error.name = 'TimeoutError';
      return error;
    };
    const result = await lookupCallsign('W1AW', bodyThatFails(timeout));

    expect(result.status).toBe('unavailable');
    expect(result.message).toMatch(/had not arrived by the time GrantSpotter stopped waiting/);
    expect(result.message).not.toMatch(/answered with something we could not read/);
  });

  /**
   * The other half of the split, and the reason it is a split rather than a rewording: when the
   * bytes DID arrive and are not JSON, saying so is a true statement about what the source served.
   * That sentence keeps its wording; it just no longer covers failures that are ours.
   */
  it('still says the source answered with something unreadable when it actually did', async () => {
    const { deps } = serve('<html>hello</html>');
    const result = await lookupCallsign('W1AW', deps);

    expect(result.status).toBe('unavailable');
    expect(result.message).toMatch(/answered with something we could not read/);
    expect(result.message).toMatch(/ours to fix, not yours/);
  });
});

/**
 * THE CLAUSE THIS REQUEST SIGNS ITSELF WITH.
 *
 * The string itself is built by the one `buildUserAgent` in `config.ts` and is asserted there,
 * against the crawler's, side by side. What belongs HERE is that the clause this module publishes
 * is a legal clause — the User-Agent is punctuated with `;` and brackets, and a clause containing
 * either would forge an extra one — and that it does not describe a crawl.
 */
describe('CALLSIGN_LOOKUP_PURPOSE', () => {
  it('is true of one request a person asked for, and claims to be no kind of crawl', () => {
    expect(CALLSIGN_LOOKUP_PURPOSE).not.toMatch(/nightly|deadline|detector/i);
    expect(CALLSIGN_LOOKUP_PURPOSE).toMatch(/callsign lookup/);
    expect(CALLSIGN_LOOKUP_PURPOSE).toMatch(/user-initiated/);
    // It may name crawling, but only to deny it: strike the denial and no claim of one is left.
    expect(CALLSIGN_LOOKUP_PURPOSE.replace(/not a crawl/g, '')).not.toMatch(/crawl/i);
  });

  it('cannot forge a second clause or split the header', () => {
    expect(CALLSIGN_LOOKUP_PURPOSE).toMatch(/^[\x20-\x7e]+$/);
    expect(CALLSIGN_LOOKUP_PURPOSE).not.toMatch(/[;()]/);
  });
});

describe('lookupCallsign: values it will not pass on', () => {
  it.each([
    'javascript:alert(1)',
    'https://phish.example/UlsApp/UlsSearch/license.jsp',
    'https://wireless2.fcc.gov.evil.example/x',
    'not a url',
  ])('drops a ULS link that is not an FCC page: %s', async (uls) => {
    const { deps } = serve(mutate('person-extra.json', (body) => { body.otherInfo.ulsUrl = uls; }));
    const result = await lookupCallsign('WV0ZZZ', deps);

    expect(result.status).toBe('found');
    // This value is rendered as an anchor the user clicks to check us against the FCC.
    expect(result.record).not.toHaveProperty('ulsUrl');
  });

  it.each(['13/45/2019', '2019-04-04', '', 'PENDING'])(
    'drops a grant date it cannot read as a date: %s',
    async (value) => {
      const { deps } = serve(
        mutate('person-extra.json', (body) => { body.otherInfo.grantDate = value; }),
      );
      const result = await lookupCallsign('WV0ZZZ', deps);

      expect(result.status).toBe('found');
      expect(result.record).not.toHaveProperty('grantDate');
    },
  );

  /**
   * THE ONE THING THIS MODULE MAY NEVER PRODUCE.
   *
   * `licensedSince` feeds `heldMonthsMin` in the matcher. The only date-shaped field in a callook
   * record is `grantDate`, which resets on every renewal and every vanity change —
   * `person-extra.json` carries `grantDate 04/04/2019` beside `previous.callsign KV0ZZZ`, the
   * shape of a real record read on 2026-08-04. Filling `licensedSince` from it would print a
   * confident eligibility verdict computed from the wrong year.
   */
  it('produces no licensedSince from any fixture, ever', async () => {
    const files = readdirSync(FIXTURES).filter((file) => file.endsWith('.json'));
    expect(files.length).toBeGreaterThan(10);

    for (const file of files) {
      const { deps } = serveFixture(file);
      const result = await lookupCallsign('WV0ZZZ', deps);
      expect(JSON.stringify(result), file).not.toContain('licensedSince');
    }
  });

  it('does not so much as name licensedSince in its code', () => {
    // The runtime check above only sees the paths the fixtures exercise. This one sees the file.
    // Comments are stripped first, because the WHY above is written in one and must stay there.
    const sources = ['callook.ts', 'types.ts'].map((file) =>
      readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*)/.test(line))
        .join('\n'),
    );

    for (const source of sources) expect(source).not.toContain('licensedSince');
    // Vacuity guard: the strip must not have eaten the code it was meant to leave behind.
    expect(sources[0]).toContain('grantDate');
  });
});
