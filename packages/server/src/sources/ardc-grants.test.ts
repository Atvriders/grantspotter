import { describe, expect, it } from 'vitest';
import { fixturePayload, loadFixture } from '../../test/fixtures.js';
import { programIdFor } from './util/ids.js';
import type { NormalizeContext } from '../normalize/index.js';
import { isDoNotPublish, normalizeRaw } from '../normalize/index.js';
import {
  ardcGrants,
  buildChildrenRequest,
  pastAwardClassification,
  resolveGrantsParentId,
} from './ardc-grants.js';

const DISCOVERY_URL =
  'https://www.ardc.net/wp-json/wp/v2/pages?slug=grants&per_page=100&_fields=id,slug,link,parent,title,modified';
/** The real parent id, read off the live API on 2026-08-03 — never hardcoded in the module. */
const PARENT_ID = 1271;
const CHILDREN_URL_PART = `parent=${PARENT_ID}`;

const discovery = () => fixturePayload('ardc-grants', '00-discovery.json', DISCOVERY_URL);
const children = () =>
  fixturePayload(
    'ardc-grants',
    '01-children.json',
    `https://www.ardc.net/wp-json/wp/v2/pages?parent=${PARENT_ID}&per_page=100`,
  );

describe('resolveGrantsParentId', () => {
  it('reads the real parent id off the captured discovery response', () => {
    expect(resolveGrantsParentId(loadFixture('ardc-grants', '00-discovery.json'))).toBe(PARENT_ID);
  });

  // The live response carries ONE page with this slug today, so the collision case cannot be
  // exercised from the capture. It is a hand-written input on purpose, and it is labelled as
  // one — ardc.net has carried a second /news/grants/ page under the same slug before.
  it('matches on the link path, not the slug, when two pages share the slug (synthetic input)', () => {
    const twoPages = JSON.stringify([
      { id: 9001, slug: 'grants', link: 'https://www.ardc.net/news/grants/', parent: 55 },
      { id: PARENT_ID, slug: 'grants', link: 'https://www.ardc.net/apply/grants/', parent: 1193 },
    ]);
    expect(resolveGrantsParentId(twoPages)).toBe(PARENT_ID);
  });

  it('returns undefined when nothing matches rather than guessing an id', () => {
    expect(resolveGrantsParentId('[]')).toBeUndefined();
    expect(resolveGrantsParentId('{"code":"rest_no_route"}')).toBeUndefined();
    expect(resolveGrantsParentId('not json')).toBeUndefined();
  });
});

describe('buildChildrenRequest', () => {
  it('asks for the child pages of the resolved parent with the fields we need', () => {
    const req = buildChildrenRequest(PARENT_ID);
    expect(req.method).toBe('GET');
    expect(req.accept).toBe('json');
    expect(req.url).toContain(CHILDREN_URL_PART);
    expect(req.url).toContain('per_page=100');
    expect(req.url).toContain('_fields=id,slug,link,title,date,modified,parent,excerpt');
    expect(req.url).not.toContain('modified_after');
  });

  it('adds modified_after for an incremental poll — the confirmed working lever', () => {
    const req = buildChildrenRequest(PARENT_ID, '2026-07-01T00:00:00.000Z');
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
    expect(requests[0].url).not.toContain(String(PARENT_ID));
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

  it('parses every child page the live API returns', () => {
    const raws = ardcGrants.parse([discovery(), children()]);
    expect(raws).toHaveLength(8);
    const y2025 = raws.find((r) => r.rawFields.slug === '2025-grants');
    expect(y2025?.externalKey).toBe('9431');
    expect(y2025?.name).toBe('2025 Grants');
    expect(y2025?.sourceUrl).toBe('https://www.ardc.net/apply/grants/2025-grants/');
    expect(y2025?.rawFields.modified).toBe('2026-02-24T12:52:44');
  });

  it('strips HTML out of the WordPress excerpt but keeps the text verbatim', () => {
    const raws = ardcGrants.parse([discovery(), children()]);
    for (const raw of raws) expect(raw.rawText).not.toContain('<p>');
    const y2025 = raws.find((r) => r.rawFields.slug === '2025-grants');
    expect(y2025?.rawFields.excerpt).toContain(
      'Information on 2025 Charitable Gifts can be found below.',
    );
  });

  it('returns [] when the children payload is missing', () => {
    expect(ardcGrants.parse([discovery()])).toEqual([]);
  });

  it('states in notes what this source actually returns, and where the opportunity is not', () => {
    expect(ardcGrants.notes).toMatch(/custom-post-type/i);
    expect(ardcGrants.notes).toMatch(/never\s+hardcoded/i);
    expect(ardcGrants.notes).toMatch(/past_award/);
    expect(ardcGrants.notes).toMatch(/February 1 April 1 July 1 September 1/);
  });
});

/**
 * B8. "Grants awarded in 2025" was published as an OPEN, club-eligible grant with an apply
 * button and 13 projected application cycles running to Sep 2029, while `ardc-award-tables`
 * classified the contents of that same URL as past awards. Which one it is, the funder says
 * itself, in the metadata this source already fetches.
 */
describe('a page of grants already made is history, not an opportunity', () => {
  const ctx = (): NormalizeContext => ({
    sourceId: 'ardc-grants',
    funderId: 'ardc',
    klass: 'ham_grant',
    tier: 'A',
    nowISO: '2026-08-02T00:00:00.000Z',
    verificationMethod: 'live_fetch',
    mintId: programIdFor,
  });

  it('classifies every one of the eight live children as a past award', () => {
    const raws = ardcGrants.parse([discovery(), children()]);
    expect(raws).toHaveLength(8);
    for (const raw of raws) {
      expect(raw.rawFields.recordType, `${raw.name} must be past_award`).toBe('past_award');
      expect(raw.rawFields.deadlineKind, `${raw.name} must be dormant`).toBe('dormant');
    }
  });

  it('suppresses them through the same predicate the review queue calls', () => {
    for (const raw of ardcGrants.parse([discovery(), children()])) {
      const program = normalizeRaw(raw, ctx());
      expect(isDoNotPublish(program), program.name).toBe(true);
      expect(program.trust.status).toBe('closed');
    }
  });

  it('projects no application cycle off a page of finished grants', () => {
    const raws = ardcGrants.parse([discovery(), children()]);
    const y2025 = raws.find((r) => r.rawFields.slug === '2025-grants');
    const program = normalizeRaw(y2025!, ctx());
    expect(program.deadline.kind).toBe('dormant');
    // The RECUR directive is what expandCycles projects from. A dormant record carries none.
    expect(program.deadline.note).not.toMatch(/RECUR/);
    expect(program.deadline.note).not.toMatch(/02-01,04-01,07-01,09-01/);
  });

  it('reads the funder’s own words, not our guess: three independent signals', () => {
    const page = { id: 1, slug: '2025-grants', link: 'https://www.ardc.net/apply/grants/2025-grants/' };
    expect(pastAwardClassification(page, '')).toBe('past_award');
    expect(pastAwardClassification({ ...page, slug: 'x' }, 'Grants awarded in 2025.')).toBe('past_award');
    expect(pastAwardClassification({ id: 1, slug: 'x', title: { rendered: '2026 Grants' } }, '')).toBe(
      'past_award',
    );
  });

  it('treats a per-project page as history too — the shape 376 award-table links use', () => {
    const page = {
      id: 2,
      slug: 'grant-hamsci-psws-expansion',
      link: 'https://www.ardc.net/apply/grants/2025-grants/grant-hamsci-psws-expansion/',
    };
    expect(pastAwardClassification(page, '$77,000 to expand the PSWS network.')).toBe('past_award');
  });

  // The other direction, and the reason this is a classifier rather than a blanket suppression:
  // an unrecognised child page still publishes. Suppressing a page nobody has described would
  // hide a real award, which is the more expensive mistake of the two.
  it('does NOT suppress a child page it cannot classify', () => {
    const page = {
      id: 3,
      slug: 'priority-areas-for-funding',
      link: 'https://www.ardc.net/apply/grants/priority-areas-for-funding/',
      title: { rendered: 'Priority Areas for Funding' },
    };
    expect(pastAwardClassification(page, 'What we look for in a proposal.')).toBeUndefined();
  });
});
