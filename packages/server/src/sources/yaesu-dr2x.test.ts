import { describe, expect, it } from 'vitest';
import { fixturePayload, loadFixture } from '../../test/fixtures.js';
import { findDr2xPdfLinks, windowFromPdfLink, yaesuDr2x } from './yaesu-dr2x.js';

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

  it('never downloads the PDF — every request is html', async () => {
    const requests = Array.isArray(yaesuDr2x.requests) ? yaesuDr2x.requests : [];
    for (const r of requests) expect(r.accept).toBe('html');
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
