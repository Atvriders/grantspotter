import type { FetchRequest } from '@grantspotter/core';

/**
 * USAspending v2 — AWARDED HISTORY for corroboration. Tier A (spec §7.5).
 *
 * award_type_codes 02/03/04/05 are block grants, formula grants, project grants and cooperative
 * agreements. Codes A-D (and the IDV codes) are PROCUREMENT CONTRACTS: omitting this filter
 * floods the inbox with defence-electronics purchase orders that no ham club can apply for.
 */
export const USASPENDING_SEARCH_URL =
  'https://api.usaspending.gov/api/v2/search/spending_by_award/';

export const USASPENDING_GRANT_TYPE_CODES: readonly string[] = Object.freeze([
  '02',
  '03',
  '04',
  '05',
]);

const FIELDS = [
  'Award ID',
  'Recipient Name',
  'Description',
  'Awarding Agency',
  'Award Amount',
  'Start Date',
  'End Date',
];

export interface UsaSpendingAward {
  /** The FAIN, e.g. "2045755". Stable identity, but NOT a usable URL segment — see `permalinkId`. */
  awardId: string;
  /**
   * `generated_internal_id`, e.g. "ASST_NON_2045755_049". This — not the FAIN — is the segment
   * usaspending.gov and the API both address an award by.
   *
   * REAL-CAPTURE FIX (2026-08-03). The award link was built from the FAIN, and every one of them
   * was dead. It looked fine because usaspending.gov is a single-page app: GET
   * /award/2045755 returns HTTP 200 text/html (the shell) and then renders nothing, exactly the
   * silent-200 failure mode that makes feeds and SPAs so dangerous here. The API is the honest
   * oracle and it is unambiguous: /api/v2/awards/2045755/ -> 404 "No Award found",
   * /api/v2/awards/ASST_NON_2045755_049/ -> 200 with the award. Never rebuild this from the FAIN.
   */
  permalinkId: string;
  recipientName: string;
  description: string;
  awardingAgency: string;
  amount?: number;
  startDate: string;
  endDate: string;
}

export function buildUsaSpendingRequest(keyword: string, page: number): FetchRequest {
  return {
    url: USASPENDING_SEARCH_URL,
    method: 'POST',
    accept: 'json',
    body: {
      filters: {
        keywords: [keyword],
        award_type_codes: [...USASPENDING_GRANT_TYPE_CODES],
        time_period: [{ start_date: '2019-01-01', end_date: '2030-12-31' }],
      },
      fields: FIELDS,
      page,
      limit: 25,
      sort: 'Award Amount',
      order: 'desc',
      subawards: false,
    },
  };
}

export function parseUsaSpending(json: string): UsaSpendingAward[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const results = (parsed as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  return results.map((entry) => {
    const row = entry as Record<string, unknown>;
    const amount = Number(row['Award Amount']);
    const award: UsaSpendingAward = {
      awardId: String(row['Award ID'] ?? ''),
      permalinkId: String(row.generated_internal_id ?? ''),
      recipientName: String(row['Recipient Name'] ?? ''),
      description: String(row.Description ?? ''),
      awardingAgency: String(row['Awarding Agency'] ?? ''),
      startDate: String(row['Start Date'] ?? ''),
      endDate: String(row['End Date'] ?? ''),
    };
    if (Number.isFinite(amount) && amount > 0) award.amount = amount;
    return award;
  });
}
