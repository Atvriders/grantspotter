import { describe, expect, it } from 'vitest';
import { parseAmount } from '@grantspotter/core';
import { fixturePayload, loadFixture } from '../../test/fixtures.js';
import { type NormalizeContext, normalizeRaw } from '../normalize/index.js';
import { programIdFor } from './util/ids.js';
import { closeDateFromBody, findDr2xPdfLinks, windowFromPdfLink, yaesuDr2x } from './yaesu-dr2x.js';

const BASE = 'https://systemfusion.yaesu.com/';
const html = () => loadFixture('yaesu-dr2x', 'pathological.html');

describe('findDr2xPdfLinks', () => {
  it('finds only the repeater-program PDFs under /wp-content/uploads/{YYYY}/{MM}/', () => {
    const links = findDr2xPdfLinks(html(), BASE);
    expect(links).toHaveLength(2);
    expect(links.map((l) => l.href)).not.toContain(
      'https://systemfusion.yaesu.com/wp-content/uploads/2024/01/System-Fusion-Brochure.pdf',
    );
  });

  it('resolves relative hrefs and reads the upload year and month from the path', () => {
    const [current] = findDr2xPdfLinks(html(), BASE);
    expect(current.href).toBe(
      'https://systemfusion.yaesu.com/wp-content/uploads/2026/06/DR-2X-Repeater-Program-June-3-August-31-2026-Fillable.pdf',
    );
    expect(current.uploadYear).toBe(2026);
    expect(current.uploadMonth).toBe(6);
  });

  it('orders newest upload first', () => {
    expect(findDr2xPdfLinks(html(), BASE)[0].uploadYear).toBe(2026);
  });
});

describe('windowFromPdfLink', () => {
  it('reads the window out of the anchor text', () => {
    const [current] = findDr2xPdfLinks(html(), BASE);
    expect(windowFromPdfLink(current)).toEqual({ opensAt: '2026-06-03', closesAt: '2026-08-31' });
  });

  it('falls back to the filename when the anchor text is generic', () => {
    const links = findDr2xPdfLinks(html(), BASE);
    expect(windowFromPdfLink(links[1])).toEqual({ opensAt: '2025-09-02', closesAt: '2025-11-30' });
  });

  it('falls back to the upload path year when the dates carry no year', () => {
    expect(
      windowFromPdfLink({
        href: 'https://systemfusion.yaesu.com/wp-content/uploads/2027/02/DR-2X-Program-March-1-May-31.pdf',
        text: 'Program form',
        uploadYear: 2027,
        uploadMonth: 2,
      }),
    ).toEqual({ opensAt: '2027-03-01', closesAt: '2027-05-31' });
  });

  it('returns undefined rather than half a window', () => {
    expect(
      windowFromPdfLink({ href: 'https://x.test/DR-2X-Program.pdf', text: 'Program form' }),
    ).toBeUndefined();
  });
});

describe('yaesuDr2x', () => {
  const raws = yaesuDr2x.parse([fixturePayload('yaesu-dr2x', 'pathological.html', BASE)]);

  it('emits one record with the current window', () => {
    expect(raws).toHaveLength(1);
    expect(raws[0].rawFields.opensAt).toBe('2026-06-03');
    expect(raws[0].rawFields.closesAt).toBe('2026-08-31');
    expect(raws[0].rawFields.formUrl).toContain('June-3-August-31-2026');
  });

  it('captures the discounted purchase prices and the 12-month on-air obligation', () => {
    expect(raws[0].rawFields.pricing).toContain('$1,450');
    expect(raws[0].rawFields.pricing).toContain('$1,860');
    expect(raws[0].rawFields.sustainment).toMatch(/twelve months/i);
  });

  // Regression coverage: feeding the raw pricing prose straight into the shared parseAmount
  // heuristic collapsed a $1,450-$1,860 discounted-purchase RANGE into a single amountMin: 1860
  // — publishing the accessory-inclusive ceiling as if it were the floor, overstating the true
  // cost of the cheapest option by $410. `.toContain('$1,450')` on the raw prose (as the old
  // suite had) cannot catch this: the substring was always present even when the parsed range
  // was wrong. Assert the EXACT min/max that the normalize layer will actually publish.
  describe('correct min/max, not a collapsed range (regression)', () => {
    it('emits an unambiguous amount field with both option prices', () => {
      expect(raws[0].rawFields.amount).toBe('$1,450 to $1,860.');
    });

    it('parses to amountMin 1450 / amountMax 1860, not a collapsed 1860/1860', () => {
      expect(parseAmount(raws[0].rawFields.amount!)).toEqual({
        amountMin: 1450,
        amountMax: 1860,
      });
    });

    it('never lets amountMin exceed the $1,450 floor', () => {
      const { amountMin } = parseAmount(raws[0].rawFields.amount!);
      expect(amountMin).toBe(1450);
    });

    it('lands correctly through the full normalize pipeline, alongside the sustainment obligation', () => {
      const ctx: NormalizeContext = {
        sourceId: 'yaesu-dr2x',
        funderId: 'yaesu-usa',
        klass: 'equipment_in_kind',
        tier: 'C',
        nowISO: '2026-08-02T00:00:00.000Z',
        verificationMethod: 'live_fetch',
        mintId: programIdFor,
      };
      const program = normalizeRaw(raws[0], ctx);
      expect(program.amount.instrument).toBe('discounted_purchase');
      expect(program.amount.amountMin).toBe(1450);
      expect(program.amount.amountMax).toBe(1860);
      // The funder's OWN sentence, off this fixture's page — not the literal that used to be
      // hard-coded in OBLIGATIONS_BY_SOURCE and asserted on every Yaesu record, including the
      // live one whose real capture never states it (close-out review B3).
      expect(program.obligations.sustainmentObligation).toBe(
        'The repeater must remain\non the air for twelve months.',
      );
    });
  });

  it('never downloads the PDF — every request is html', async () => {
    const requests = Array.isArray(yaesuDr2x.requests) ? yaesuDr2x.requests : [];
    for (const r of requests) expect(r.accept).toBe('html');
  });

  it('records where each window date came from', () => {
    expect(raws[0].rawFields.windowSource).toBe('pdf_title');
  });

  it('says in notes that this is a discounted purchase, not a grant', () => {
    expect(yaesuDr2x.notes).toMatch(/discounted purchase, not a grant/i);
    expect(yaesuDr2x.notes).toMatch(/PDF title/i);
  });

  it('returns [] when no program PDF is linked, so the yield alarm fires', () => {
    expect(
      yaesuDr2x.parse([
        { url: BASE, status: 200, contentType: 'text/html', body: '<p>Coming soon.</p>', fetchedAt: '2026-08-02T00:00:00.000Z' },
      ]),
    ).toEqual([]);
  });

  // Extra edge-case fixtures beyond the brief's inline cases: a landing page that never links
  // the program PDF at all, and one where the linked PDF's filename doesn't parse into a
  // window. Both must fail loud (empty result) rather than fabricate a date.
  it('returns [] against a committed fixture where the landing page links no program PDF', () => {
    expect(yaesuDr2x.parse([fixturePayload('yaesu-dr2x', 'no-pdf-link.html', BASE)])).toEqual([]);
  });

  it('returns [] against a committed fixture where the linked PDF filename does not parse into a window', () => {
    expect(
      yaesuDr2x.parse([fixturePayload('yaesu-dr2x', 'unparseable-filename.html', BASE)]),
    ).toEqual([]);
  });
});

// The committed REAL capture, fixtures/yaesu-dr2x/00-systemfusion-yaesu-com.html — pulled from
// systemfusion.yaesu.com on 2026-08-03 through the production fetcher. Everything above this
// line drove only synthetic HTML this module's author wrote, and against the actual landing page
// this source parsed ZERO records.
describe('yaesuDr2x (REAL fixture — this source parsed ZERO records from its own live page)', () => {
  // Raw HTML, fixtures/yaesu-dr2x/00-systemfusion-yaesu-com.html:
  //   line 308: <h4>Yaesu USA is please to offer this DR-2X Program offering to our loyal
  //             customers once again through August 31st, 2026.</h4>
  //   line 310: <a … href="https://systemfusion.yaesu.com/wp-content/uploads/2026/06/
  //             DR-2X_Jun-thru-Aug_2026-FILLABLE.pdf" …>DR-2X REPEATER APPLICATION</a>
  //   line 314: The new program price is either $1,450.00 or $1,860.00.
  // Two failures met here: the form filename is MONTH-granular ("Jun thru Aug 2026") so no
  // day-precision window can be read from it, and the anchor text carries no dates at all — yet
  // the module required both an opensAt and a closesAt from exactly those two strings. Separately
  // the live prices carry cents, and the pricing capture treated the cents separator in
  // "$1,450.00" as the end of the sentence.
  const raws = yaesuDr2x.parse([
    fixturePayload('yaesu-dr2x', '00-systemfusion-yaesu-com.html', BASE),
  ]);

  it('parses exactly one record from the live page (it used to parse none)', () => {
    expect(raws).toHaveLength(1);
  });

  it('finds the month-granular program form the live page actually links', () => {
    const links = findDr2xPdfLinks(loadFixture('yaesu-dr2x', '00-systemfusion-yaesu-com.html'), BASE);
    expect(links).toHaveLength(1);
    expect(links[0].href).toBe(
      'https://systemfusion.yaesu.com/wp-content/uploads/2026/06/DR-2X_Jun-thru-Aug_2026-FILLABLE.pdf',
    );
    expect(links[0].text).toBe('DR-2X REPEATER APPLICATION');
    // The documented "read the window out of the PDF title" path yields nothing here — that is
    // the finding, not a test workaround.
    expect(windowFromPdfLink(links[0])).toBeUndefined();
  });

  it('takes the close date from the page prose, and says so', () => {
    expect(raws[0].rawFields.closesAt).toBe('2026-08-31');
    expect(raws[0].rawFields.windowSource).toBe('page_body');
  });

  it('invents no opening date from the "Jun" in the filename or the /2026/06/ upload path', () => {
    expect(raws[0].rawFields.opensAt).toBeUndefined();
  });

  it('parses "through August 31st, 2026" with its ordinal suffix', () => {
    expect(closeDateFromBody('… once again through August 31st, 2026.')).toBe('2026-08-31');
    expect(closeDateFromBody('Applications are not currently open.')).toBeUndefined();
  });

  // The domain fact this source exists to get right: $1,450 for the repeater, $1,860 with the
  // LAN-01A. On the live page both figures carry cents, and the old capture stopped dead at the
  // first decimal point — publishing a flat $1,450 and losing the accessory-inclusive ceiling.
  it('captures BOTH live prices, cents and all, instead of truncating at the decimal point', () => {
    expect(raws[0].rawFields.pricing).toBe(
      'The new program price is either $1,450.00 or $1,860.00.',
    );
  });

  it('still publishes amountMin 1450 / amountMax 1860 from the live page', () => {
    expect(raws[0].rawFields.amount).toBe('$1,450 to $1,860.');
    expect(parseAmount(raws[0].rawFields.amount!)).toEqual({ amountMin: 1450, amountMax: 1860 });
  });

  it('lands as a discounted purchase at 1450-1860 through the full normalize pipeline', () => {
    const ctx: NormalizeContext = {
      sourceId: 'yaesu-dr2x',
      funderId: 'yaesu-usa',
      klass: 'equipment_in_kind',
      tier: 'C',
      nowISO: '2026-08-03T00:00:00.000Z',
      verificationMethod: 'live_fetch',
      mintId: programIdFor,
    };
    const program = normalizeRaw(raws[0], ctx);
    expect(program.amount.instrument).toBe('discounted_purchase');
    expect(program.amount.amountMin).toBe(1450);
    expect(program.amount.amountMax).toBe(1860);
  });

  // HONEST NEGATIVE: the 12-month on-air obligation is a real term of this program, but it is
  // not stated anywhere on the landing page — it lives in the application PDF, which this module
  // deliberately never downloads. Asserting it here off a page that does not say it would be
  // exactly the fabrication the real-fixture exercise exists to catch.
  it('does NOT assert the 12-month obligation, because the live page never states it', () => {
    expect(raws[0].rawFields.sustainment).toBeUndefined();
    expect(raws[0].rawText).not.toMatch(/twelve months|12 months/i);
    expect(yaesuDr2x.notes).toMatch(/12-month on-air obligation is NOT stated/);
  });
});
