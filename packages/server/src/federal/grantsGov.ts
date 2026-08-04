import type { FetchRequest, RawOpportunity } from '@grantspotter/core';
import { flattenHtml } from '../sources/util/text.js';

/**
 * Grants.gov, key-free.
 *
 * DO NOT USE THE ADVERTISED RSS FEEDS. All four return HTTP 200 with content-type text/html —
 * a ~27 KB single-page-app shell, not XML. A naive poller finds zero items forever and never
 * errors, which is the worst possible failure mode. search2 below is key-free and returns real
 * JSON.
 *
 * Relevance note: "amateur radio" returns 57 hits and "cubesat" returns exactly 1. The
 * genuinely winnable federal money is ADJACENT — NSF geospace/ECCS/ATE/Noyce, NASA Space Grant
 * and MUREP, NTIA PWSCIF — which is why federal/adjacency.ts exists and why a keyword match
 * alone is not enough. This module fetches and parses faithfully; it does not filter.
 */
export const GRANTS_GOV_SEARCH_URL = 'https://api.grants.gov/v1/api/search2';
export const GRANTS_GOV_FETCH_URL = 'https://api.grants.gov/v1/api/fetchOpportunity';
const OPPORTUNITY_PAGE = 'https://www.grants.gov/search-results-detail/';

export const GRANTS_GOV_KEYWORDS: readonly string[] = Object.freeze([
  'amateur radio',
  'radio frequency spectrum wireless STEM education',
  'geospace ionosphere space weather',
  'undergraduate radio science instrumentation',
  'technician education wireless communications',
]);

export interface GrantsGovHit {
  id: string;
  number: string;
  title: string;
  agency: string;
  agencyCode: string;
  openDate: string;
  closeDate: string;
  oppStatus: string;
  docType: string;
  cfdaList: string[];
}

export interface GrantsGovDetail {
  opportunityId: string;
  awardCeiling?: number;
  awardFloor?: number;
  applicantTypes: string[];
  responseDate?: string;
  postingDate?: string;
  lastUpdatedDate?: string;
  description: string;
}

export function buildSearchRequest(
  keyword: string,
  rows: number,
  startRecordNum: number,
): FetchRequest {
  return {
    url: GRANTS_GOV_SEARCH_URL,
    method: 'POST',
    accept: 'json',
    body: {
      keyword,
      rows,
      startRecordNum,
      oppStatuses: 'posted|forecasted',
      sortBy: 'openDate|desc',
    },
  };
}

export function buildFetchOpportunityRequest(opportunityId: string): FetchRequest {
  return {
    url: GRANTS_GOV_FETCH_URL,
    method: 'POST',
    accept: 'json',
    body: { opportunityId: Number.parseInt(opportunityId, 10) },
  };
}

/**
 * awardCeiling and awardFloor are FREQUENTLY the literal string "none". Returning 0 here would
 * render "$0 award" in the UI, and a confidently-displayed wrong number is this product's
 * primary failure mode. A genuine "0" is preserved and is distinct from "none".
 */
export function parseGrantsGovMoney(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '' || /^none$/i.test(trimmed)) return undefined;
  const digits = trimmed.replace(/[$,\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(digits)) return undefined;
  const n = Number.parseFloat(digits);
  return Number.isFinite(n) ? n : undefined;
}

function safeJson(json: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * REAL-CAPTURE FIX (2026-08-03). search2 returns JSON, but the strings inside it are HTML: 8 of
 * the 128 hits in the committed capture carry `&ndash;`, `&amp;`, `&nbsp;`, `&rsquo;` or
 * `&ocirc;` in the title. Only the synopsis was being flattened, so those entities travelled
 * uncorrected into `RawOpportunity.name` and therefore into `Program.name`, where the reviewer
 * would read a literal "Grant Program &ndash; Solutions for AI-Native RAN". flattenHtml decodes
 * them and also strips the trailing runs of `&nbsp;` that Grants.gov titles are padded with.
 */
export function parseSearchResponse(json: string): GrantsGovHit[] {
  const root = safeJson(json);
  if (!root || root.errorcode !== 0) return [];
  const data = root.data as { oppHits?: unknown } | undefined;
  if (!data || !Array.isArray(data.oppHits)) return [];
  return (data.oppHits as Array<Record<string, unknown>>).map((h) => ({
    id: String(h.id ?? ''),
    number: String(h.number ?? ''),
    title: flattenHtml(String(h.title ?? '')),
    // Truncated to 50 characters by the API itself, e.g. "National Telecommunications and
    // Information Admini" — that is upstream's doing and is left verbatim.
    agency: flattenHtml(String(h.agency ?? '')),
    agencyCode: String(h.agencyCode ?? ''),
    openDate: String(h.openDate ?? ''),
    closeDate: String(h.closeDate ?? ''),
    oppStatus: String(h.oppStatus ?? ''),
    docType: String(h.docType ?? ''),
    cfdaList: Array.isArray(h.cfdaList) ? (h.cfdaList as unknown[]).map(String) : [],
  }));
}

export function parseOpportunityDetail(json: string): GrantsGovDetail | undefined {
  const root = safeJson(json);
  if (!root || root.errorcode !== 0) return undefined;
  const data = root.data as Record<string, unknown> | undefined;
  const synopsis = data?.synopsis as Record<string, unknown> | undefined;
  if (!synopsis) return undefined;

  const applicantTypes = Array.isArray(synopsis.applicantTypes)
    ? (synopsis.applicantTypes as Array<Record<string, unknown>>).map((t) =>
        String(t.description ?? t.id ?? ''),
      )
    : [];

  const detail: GrantsGovDetail = {
    opportunityId: String(synopsis.opportunityId ?? data?.id ?? ''),
    awardCeiling: parseGrantsGovMoney(synopsis.awardCeiling),
    awardFloor: parseGrantsGovMoney(synopsis.awardFloor),
    applicantTypes,
    description: flattenHtml(String(synopsis.synopsisDesc ?? '')),
  };
  if (typeof synopsis.responseDate === 'string') detail.responseDate = synopsis.responseDate;
  if (typeof synopsis.postingDate === 'string') detail.postingDate = synopsis.postingDate;
  if (typeof synopsis.lastUpdatedDate === 'string')
    detail.lastUpdatedDate = synopsis.lastUpdatedDate;
  return detail;
}

export function toRawOpportunity(hit: GrantsGovHit, detail?: GrantsGovDetail): RawOpportunity {
  const rawFields: Record<string, string> = {
    opportunityNumber: hit.number,
    agency: hit.agency,
    agencyCode: hit.agencyCode,
    openDate: hit.openDate,
    closeDate: hit.closeDate,
    oppStatus: hit.oppStatus,
    docType: hit.docType,
    cfda: hit.cfdaList.join(', '),
  };
  if (detail) {
    if (detail.applicantTypes.length > 0)
      rawFields.applicantTypes = detail.applicantTypes.join('; ');
    if (detail.lastUpdatedDate) rawFields.lastUpdatedDate = detail.lastUpdatedDate;
    if (detail.responseDate) rawFields.responseDate = detail.responseDate;
    // Only write amountRaw when there is a real figure. "none" must not become "$0".
    const floor = detail.awardFloor;
    const ceiling = detail.awardCeiling;
    if (floor !== undefined || ceiling !== undefined) {
      rawFields.amountRaw = [
        floor !== undefined ? `$${floor.toLocaleString('en-US')}` : undefined,
        ceiling !== undefined ? `$${ceiling.toLocaleString('en-US')}` : undefined,
      ]
        .filter(Boolean)
        .join(' to ');
    }
  }

  return {
    sourceId: 'grants-gov-federal',
    externalKey: hit.id,
    name: hit.title,
    rawFields,
    sourceUrl: `${OPPORTUNITY_PAGE}${hit.id}`,
    rawText: [hit.title, hit.agency, detail?.description ?? ''].filter(Boolean).join('\n'),
  };
}
