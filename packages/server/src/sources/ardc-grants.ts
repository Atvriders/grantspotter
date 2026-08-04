import type { FetchRequest, FetchedPayload, RawOpportunity } from '@grantspotter/core';
import type { FollowUpContext, FollowUpSource } from './types.js';
import { pickPayload } from './util/payload.js';
import { flattenHtml } from './util/text.js';

const SOURCE_ID = 'ardc-grants';
const API = 'https://www.ardc.net/wp-json/wp/v2/pages';
const DISCOVERY_URL = `${API}?slug=grants&per_page=100&_fields=id,slug,link,parent,title,modified`;
const CHILD_FIELDS = 'id,slug,link,title,date,modified,parent,excerpt';

export interface WpPage {
  id?: number;
  slug?: string;
  link?: string;
  parent?: number;
  title?: { rendered?: string };
  date?: string;
  modified?: string;
  excerpt?: { rendered?: string };
}

/**
 * A child page of /apply/grants/ that is a YEAR ARCHIVE of grants already made — not an
 * opportunity. Three independent signals, every one of them present in the real capture
 * (fixtures/ardc-grants/01-children.json, fetched 2026-08-03 from
 * `wp/v2/pages?parent=1271`): the slug (`2025-grants`), the title (`2025 Grants`), and the
 * funder's own excerpt, which is the award table itself — verbatim, for the 2025 page:
 *
 *   "Information on 2025 Charitable Gifts can be found below. … Date Grantee Project Amount
 *    October 2025 Central Kansas Amateur Radio Club Inc. FieldLab WØCY $35,640 …"
 *
 * ALL EIGHT children the live API returns (2019 … 2026) match. There is not one application
 * page among them: ARDC's application lives at /apply/ and its instructions at
 * /apply/grant-application-instructions/, neither of which is a child of this parent and
 * neither of which this source fetches.
 *
 * `ardc-award-tables` fetches these same eight URLs and classifies every row inside them
 * `past_award`. Publishing the container as an open, club-eligible grant while suppressing its
 * contents is the repo contradicting itself about the same bytes.
 */
const YEAR_ARCHIVE_SLUG = /^\d{4}-grants$/;
const YEAR_ARCHIVE_TITLE = /^\d{4}\s+grants$/i;
const YEAR_ARCHIVE_EXCERPT = /\bgrants awarded in \d{4}\b|\bcharitable gifts\b/i;

/**
 * A per-project page. Not present among the live children today, but 376 distinct links of
 * exactly this shape appear inside the eight captured award tables
 * (fixtures/ardc-award-tables/0*.html), e.g.
 * `/apply/grants/2025-grants/grant-digital-communications-enhancement/` — every one of them a
 * row in a table of money already handed out, and not one of them without the `{YYYY}-grants`
 * segment. The `grant-` slug prefix is ARDC's own marker for "this is a grant we made".
 */
const FUNDED_PROJECT_SLUG = /^grant-/;

/**
 * `past_award` when the funder's own metadata says this page is a record of grants already
 * made, `undefined` when it does not. `normalize/` turns `past_award` into status `closed` plus
 * the `do_not_publish` tag, which is what keeps a page of history out of the review queue.
 *
 * Silence is NOT read as history: a child page this function cannot classify still publishes as
 * an opportunity, because suppressing a page nobody has described would hide a real award.
 */
export function pastAwardClassification(page: WpPage, excerpt: string): string | undefined {
  const slug = page.slug ?? '';
  const title = (page.title?.rendered ?? '').replace(/\s+/g, ' ').trim();
  if (YEAR_ARCHIVE_SLUG.test(slug) || YEAR_ARCHIVE_TITLE.test(title)) return 'past_award';
  if (YEAR_ARCHIVE_EXCERPT.test(excerpt)) return 'past_award';
  if (FUNDED_PROJECT_SLUG.test(slug)) return 'past_award';
  return undefined;
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
    'hardcoded. modified_after is the confirmed working incremental lever. WHAT THIS SOURCE ' +
    'ACTUALLY RETURNS, captured live 2026-08-03 (parent id 1271): EIGHT children, one per year ' +
    '2019-2026, every one of them an archive of grants already made — the funder’s own excerpt ' +
    'is the award table ("Information on 2025 Charitable Gifts can be found below. Date ' +
    'Grantee Project Amount…"). Not one is an application page, so every record this source ' +
    'produces today carries recordType past_award and is suppressed; ardc-award-tables mines ' +
    'the same eight URLs row by row. THE OPPORTUNITY ITSELF IS NOT HERE: ARDC publishes its ' +
    'application, its four deadlines ("The 2026 application deadlines are: February 1 April 1 ' +
    'July 1 September 1", verbatim) and its open-access requirement on https://www.ardc.net/' +
    'apply/, and its 20% indirect-cost cap on /apply/grant-application-instructions/ (page id ' +
    '4921) — neither is a child of /apply/grants/ and neither is fetched here, so neither is ' +
    'asserted anywhere in this pipeline. ardc.net/feed/ carries news only and zero grant ' +
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
      const recordType = pastAwardClassification(page, excerpt);
      const rawFields: Record<string, string> = {
        slug: page.slug ?? '',
        link: page.link,
        date: page.date ?? '',
        modified: page.modified ?? '',
        excerpt,
      };
      if (recordType !== undefined) {
        rawFields.recordType = recordType;
        // Without this the record keeps KIND_BY_SOURCE's `n_fixed_dates` and its RECUR directive,
        // and `expandCycles` projects application deadlines onto a page of finished grants — 13
        // future rows for "2025 Grants" alone, through Sep 2029. `dormant` is the kind
        // `ardc-award-tables` already gives the very same URLs.
        rawFields.deadlineKind = 'dormant';
      }
      out.push({
        sourceId: SOURCE_ID,
        externalKey: String(page.id),
        name,
        rawFields,
        sourceUrl: page.link,
        rawText: [name, excerpt].filter(Boolean).join('\n'),
      });
    }
    return out;
  },
};
