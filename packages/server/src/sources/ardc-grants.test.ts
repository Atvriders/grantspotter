import { describe, expect, it } from 'vitest';
import { fixturePayload, loadFixture } from '../../test/fixtures.js';
import { ardcGrants, buildChildrenRequest, resolveGrantsParentId } from './ardc-grants.js';

const DISCOVERY_URL =
  'https://www.ardc.net/wp-json/wp/v2/pages?slug=grants&per_page=100&_fields=id,slug,link,parent,title,modified';
const CHILDREN_URL_PART = 'parent=4821';

const discovery = () => fixturePayload('ardc-grants', '00-discovery.json', DISCOVERY_URL);
const children = () =>
  fixturePayload(
    'ardc-grants',
    '01-children.json',
    'https://www.ardc.net/wp-json/wp/v2/pages?parent=4821&per_page=100',
  );

describe('resolveGrantsParentId', () => {
  it('picks the page whose link is the /apply/grants/ page, not another page with the same slug', () => {
    expect(resolveGrantsParentId(loadFixture('ardc-grants', '00-discovery.json'))).toBe(4821);
  });

  it('returns undefined when nothing matches rather than guessing an id', () => {
    expect(resolveGrantsParentId('[]')).toBeUndefined();
    expect(resolveGrantsParentId('{"code":"rest_no_route"}')).toBeUndefined();
    expect(resolveGrantsParentId('not json')).toBeUndefined();
  });
});

describe('buildChildrenRequest', () => {
  it('asks for the child pages of the resolved parent with the fields we need', () => {
    const req = buildChildrenRequest(4821);
    expect(req.method).toBe('GET');
    expect(req.accept).toBe('json');
    expect(req.url).toContain('parent=4821');
    expect(req.url).toContain('per_page=100');
    expect(req.url).toContain('_fields=id,slug,link,title,date,modified,parent,excerpt');
    expect(req.url).not.toContain('modified_after');
  });

  it('adds modified_after for an incremental poll — the confirmed working lever', () => {
    const req = buildChildrenRequest(4821, '2026-07-01T00:00:00.000Z');
    expect(req.url).toContain('modified_after=2026-07-01T00%3A00%3A00.000Z');
  });
});

describe('ardcGrants source module', () => {
  it('is Tier A and starts with the discovery request only', async () => {
    expect(ardcGrants.tier).toBe('A');
    const requests = Array.isArray(ardcGrants.requests) ? ardcGrants.requests : [];
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toContain('slug=grants');
    expect(requests[0].url).not.toMatch(/parent=\d/);
  });

  it('never hardcodes a parent page id anywhere in its requests', async () => {
    const requests = Array.isArray(ardcGrants.requests) ? ardcGrants.requests : [];
    expect(requests[0].url).not.toContain('4821');
  });

  it('followUp resolves the parent at runtime and asks for its children', () => {
    const [req] = ardcGrants.followUp([discovery()]);
    expect(req.url).toContain(CHILDREN_URL_PART);
  });

  it('followUp passes sinceISO through as modified_after', () => {
    const [req] = ardcGrants.followUp([discovery()], { sinceISO: '2026-07-01T00:00:00.000Z' });
    expect(req.url).toContain('modified_after=');
  });

  it('followUp returns [] when discovery failed, rather than throwing mid-crawl', () => {
    expect(ardcGrants.followUp([])).toEqual([]);
  });

  it('parses child pages into RawOpportunity records', () => {
    const raws = ardcGrants.parse([discovery(), children()]);
    expect(raws).toHaveLength(3);
    const psws = raws.find((r) => r.name.includes('HamSCI'));
    expect(psws?.externalKey).toBe('6402');
    expect(psws?.sourceUrl).toBe('https://www.ardc.net/apply/grants/grant-hamsci-psws-expansion/');
    expect(psws?.rawFields.modified).toBe('2026-04-02T09:00:00');
    expect(psws?.rawFields.slug).toBe('grant-hamsci-psws-expansion');
    expect(psws?.rawText).toContain('$77,000');
  });

  it('strips HTML out of the WordPress excerpt but keeps the text verbatim', () => {
    const raws = ardcGrants.parse([discovery(), children()]);
    for (const raw of raws) expect(raw.rawText).not.toContain('<p>');
  });

  it('returns [] when the children payload is missing', () => {
    expect(ardcGrants.parse([discovery()])).toEqual([]);
  });

  it('documents the four fixed cycles and the no-custom-post-type finding in notes', () => {
    expect(ardcGrants.notes).toMatch(/Feb 1/);
    expect(ardcGrants.notes).toMatch(/custom-post-type/i);
    expect(ardcGrants.notes).toMatch(/never hardcode/i);
  });
});
