import { describe, expect, it } from 'vitest';
import { makeSinglePageSource } from './singlePage.js';

const cfg = {
  id: 'demo-source',
  funderId: 'demo-funder',
  label: 'Demo',
  tier: 'C' as const,
  klass: 'ham_grant' as const,
  url: 'https://example.test/demo',
  name: 'Demo Program',
  externalKey: 'demo-program',
  fieldPatterns: {
    windows: /(February\s+1[^.]*?October\s+31)/i,
    amount: /(\$[\d,]+)/,
  },
  requiredFields: ['windows'],
  expectedMinRecords: 1,
};

const page = (body: string) => ({
  url: 'https://example.test/demo',
  status: 200,
  contentType: 'text/html',
  body,
  fetchedAt: '2026-08-02T00:00:00.000Z',
});

describe('makeSinglePageSource', () => {
  it('produces a SourceModule with the contract fields', () => {
    const m = makeSinglePageSource(cfg);
    expect(m.id).toBe('demo-source');
    expect(m.requests).toEqual([{ url: cfg.url, method: 'GET', accept: 'html' }]);
    expect(m.expectedMinRecords).toBe(1);
  });

  it('extracts every matching field over the flattened text', () => {
    const m = makeSinglePageSource(cfg);
    const raws = m.parse([page('<p>February 1 - 28, June 1 - 30, and October 31.</p><p>$3,000</p>')]);
    expect(raws).toHaveLength(1);
    expect(raws[0].rawFields.windows).toContain('October 31');
    expect(raws[0].rawFields.amount).toBe('$3,000');
    expect(raws[0].externalKey).toBe('demo-program');
    expect(raws[0].name).toBe('Demo Program');
    expect(raws[0].rawText).toContain('February 1');
  });

  it('returns [] when a required field does not match, so the yield alarm fires', () => {
    const m = makeSinglePageSource(cfg);
    expect(m.parse([page('<p>nothing useful here</p>')])).toEqual([]);
  });

  it('returns [] when the payload is missing entirely', () => {
    expect(makeSinglePageSource(cfg).parse([])).toEqual([]);
  });

  it('omits an optional field that does not match rather than storing an empty string', () => {
    const m = makeSinglePageSource(cfg);
    const raws = m.parse([page('<p>February 1 - 28 ... October 31.</p>')]);
    expect(raws[0].rawFields.amount).toBeUndefined();
  });

  it('appends extraParse records after the main record', () => {
    const m = makeSinglePageSource({
      ...cfg,
      extraParse: (flat, _html, sourceUrl) =>
        flat.includes('Recipients')
          ? [
              {
                sourceId: cfg.id,
                externalKey: 'award:demo',
                name: 'Demo Award',
                rawFields: { recordType: 'past_award' },
                sourceUrl,
                rawText: 'Demo Award',
              },
            ]
          : [],
    });
    const raws = m.parse([page('<p>February 1 - 28 ... October 31.</p><h2>Recipients</h2>')]);
    expect(raws).toHaveLength(2);
    expect(raws[1].rawFields.recordType).toBe('past_award');
  });
});
