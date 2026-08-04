import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FIXTURE_ROOT, loadFixture } from '../../test/fixtures.js';
import { CALLOOK_BASE_URL, lookupCallsign, type CallsignLookupDeps } from './callook.js';

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

/** A transport that answers every request with one body, and records what it was asked. */
function serve(
  body: string,
  init: { status?: number; headers?: Record<string, string> } = {},
): { deps: CallsignLookupDeps; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  return {
    calls,
    deps: {
      now: () => Date.parse(AT),
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
  otherInfo: { grantDate: string; expiryDate: string; frn: string; ulsUrl: string };
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

    expect(result.status).toBe('not_us');
    expect(calls).toHaveLength(0);
    expect(result.message?.length).toBeLessThan(600);
  });

  it.each(['G0ABC', 'JA1XYZ', 'VE3ABC', '', '???', 'W1AW/4', '../../etc/passwd'])(
    'makes no request at all for %s',
    async (input) => {
      const { deps, calls } = serveFixture('00-callook-info-w1aw-json.json');
      const result = await lookupCallsign(input, deps);

      expect(result.status).toBe('not_us');
      expect(calls).toHaveLength(0);
    },
  );
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
      transport: (_url, init) => {
        signals.push(init.signal);
        return Promise.reject(new Error('ECONNRESET'));
      },
    };
    const result = await lookupCallsign('W1AW', deps);

    expect(signals).toHaveLength(1);
    expect(result.status).toBe('unavailable');
  });

  it('reports an HTTP status as the source having trouble', async () => {
    const { deps, calls } = serve('<html>503</html>', { status: 503 });
    const result = await lookupCallsign('W1AW', deps);

    expect(result.status).toBe('unavailable');
    expect(result.message).toContain('503');
    // No retry on a status: a 429 or a 503 is a request to be left alone, and this path has no
    // backoff to honour it with.
    expect(calls).toHaveLength(1);
  });

  it('does not follow a redirect', async () => {
    const { deps, calls } = serve('', {
      status: 301,
      headers: { location: 'https://example.invalid/W1AW/json' },
    });
    const result = await lookupCallsign('W1AW', deps);

    expect(result.status).toBe('unavailable');
    expect(calls).toHaveLength(1);
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
