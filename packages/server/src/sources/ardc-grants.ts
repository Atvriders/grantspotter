import type { FetchRequest, FetchedPayload, RawOpportunity } from '@grantspotter/core';
import type { FollowUpContext, FollowUpSource } from './types.js';
import { pickPayload } from './util/payload.js';
import { flattenHtml } from './util/text.js';

const SOURCE_ID = 'ardc-grants';
const API = 'https://www.ardc.net/wp-json/wp/v2/pages';
const DISCOVERY_URL = `${API}?slug=grants&per_page=100&_fields=id,slug,link,parent,title,modified`;
const CHILD_FIELDS = 'id,slug,link,title,date,modified,parent,excerpt';

interface WpPage {
  id?: number;
  slug?: string;
  link?: string;
  parent?: number;
  title?: { rendered?: string };
  date?: string;
  modified?: string;
  excerpt?: { rendered?: string };
}

function parseJsonArray(json: string): WpPage[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? (value as WpPage[]) : [];
  } catch {
    return [];
  }
}

/**
 * ARDC has NO grant custom-post-type (wp/v2/types returns post/page/attachment only) — grants
 * are hierarchical PAGES under /apply/grants/. The parent id must be resolved at runtime;
 * hardcoding it breaks the moment ARDC re-publishes the page. More than one page can carry
 * the slug "grants", so we match on the link path, not on the slug alone.
 */
export function resolveGrantsParentId(discoveryJson: string): number | undefined {
  for (const page of parseJsonArray(discoveryJson)) {
    if (typeof page.id !== 'number' || typeof page.link !== 'string') continue;
    if (new URL(page.link).pathname.replace(/\/$/, '') === '/apply/grants') return page.id;
  }
  return undefined;
}

export function buildChildrenRequest(parentId: number, sinceISO?: string): FetchRequest {
  const params = new URLSearchParams({
    parent: String(parentId),
    per_page: '100',
  });
  // modified_after is confirmed working on ardc.net and is the whole point of using the API.
  if (sinceISO) params.set('modified_after', sinceISO);
  // _fields is appended manually (not via URLSearchParams) so its commas stay literal instead
  // of being percent-encoded — WordPress's REST API only recognizes the literal comma form.
  const url = `${API}?${params.toString()}&_fields=${CHILD_FIELDS}`;
  return { url, method: 'GET', accept: 'json' };
}

export const ardcGrants: FollowUpSource = {
  id: SOURCE_ID,
  funderId: 'ardc',
  label: 'ARDC Grants Program (WordPress REST API)',
  tier: 'A',
  klass: 'ham_grant',
  requests: [{ url: DISCOVERY_URL, method: 'GET', accept: 'json' }],
  expectedMinRecords: 1,
  notes:
    'The only ham-relevant source in existence with a real, key-free API. ARDC has no grant ' +
    'custom-post-type (wp/v2/types = post/page/attachment only): grants are hierarchical ' +
    'PAGES under /apply/grants/, so the parent page id is resolved at runtime and never ' +
    'hardcoded. modified_after is the confirmed working incremental lever. Four fixed ' +
    'application cycles: Feb 1, Apr 1, Jul 1, Sep 1; anything after Sep 1 rolls to the next ' +
    'Feb 1, and evaluation takes 60-120 days. All ARDC output must be open-source/open-access ' +
    'and indirect costs are capped at 20%. ardc.net/feed/ carries news only and zero grant ' +
    'announcements — deliberately not a source.',

  followUp(payloads: FetchedPayload[], ctx?: FollowUpContext): FetchRequest[] {
    const discovery = pickPayload(payloads, 'slug=grants');
    if (!discovery) return [];
    const parentId = resolveGrantsParentId(discovery.body);
    if (parentId === undefined) return [];
    return [buildChildrenRequest(parentId, ctx?.sinceISO)];
  },

  parse(payloads: FetchedPayload[]): RawOpportunity[] {
    const children = payloads.find((p) => p.url.includes('parent=') && p.status === 200);
    if (!children) return [];
    const out: RawOpportunity[] = [];
    for (const page of parseJsonArray(children.body)) {
      if (typeof page.id !== 'number' || typeof page.link !== 'string') continue;
      const name = flattenHtml(page.title?.rendered ?? '') || page.slug || String(page.id);
      const excerpt = flattenHtml(page.excerpt?.rendered ?? '');
      out.push({
        sourceId: SOURCE_ID,
        externalKey: String(page.id),
        name,
        rawFields: {
          slug: page.slug ?? '',
          link: page.link,
          date: page.date ?? '',
          modified: page.modified ?? '',
          excerpt,
        },
        sourceUrl: page.link,
        rawText: [name, excerpt].filter(Boolean).join('\n'),
      });
    }
    return out;
  },
};
