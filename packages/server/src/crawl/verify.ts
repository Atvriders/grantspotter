import type { FetchedPayload, SourceTier } from '@grantspotter/core';
import type { Fetcher } from '../fetcher/index.js';
import { SOURCES, getSource } from '../sources/registry.js';
import { hasFollowUp, resolveRequests } from '../sources/types.js';

/**
 * `verify-sources` is the LIVE, warn-only counterweight to the offline fixture suite (spec
 * §7.4). It hits the real internet through the fetcher (so the blocklist, robots.txt and
 * per-host crawl-delay still apply — this politely pokes ~25 small nonprofit sites, never in
 * parallel within a host) and reports drift: did it fetch, how many records did the live page
 * yield versus `expectedMinRecords` and the committed fixture, what changed. It NEVER gates a
 * build — see `verifyExitCode`, which always returns 0.
 */

export interface VerifyRow {
  sourceId: string;
  tier: SourceTier;
  url: string;
  status: number | 'error';
  parsedCount: number;
  expectedMinRecords: number;
  ok: boolean;
  note: string;
}

/**
 * Pure classifier: given what happened on the wire, is this source's live yield acceptable?
 * Distinguishes a genuine parser/site problem from the two things that are NOT drift:
 *   - a site that deliberately declines non-browser clients (reported by the caller as status
 *     403/418/etc — this function still calls that "not ok" so it surfaces, but the *note* on
 *     the VerifyRow for those known Tier D holdouts is expected to read as a site decline, not
 *     a parser failure, once the caller labels it; see verifySources's DECLINED_HOSTS handling)
 *   - a source whose `expectedMinRecords` is 0 (e.g. austin-arc between Aug 1 and Apr 30):
 *     `parsedCount === 0` there is correct, not drift.
 */
export function verifyRowFor(
  sourceId: string,
  status: number | 'error',
  parsedCount: number,
  expectedMinRecords: number,
  url: string,
  tier: SourceTier,
): VerifyRow {
  if (status === 'error') {
    return { sourceId, tier, url, status, parsedCount, expectedMinRecords, ok: false, note: 'fetch failed' };
  }
  if (status < 200 || status >= 300) {
    return { sourceId, tier, url, status, parsedCount, expectedMinRecords, ok: false, note: `HTTP ${status}` };
  }
  if (expectedMinRecords > 0 && parsedCount < expectedMinRecords) {
    return {
      sourceId,
      tier,
      url,
      status,
      parsedCount,
      expectedMinRecords,
      ok: false,
      note: `parsed ${parsedCount}, expected at least ${expectedMinRecords}`,
    };
  }
  return { sourceId, tier, url, status, parsedCount, expectedMinRecords, ok: true, note: '' };
}

/**
 * Declined-by-design hosts (spec §7.1 / global constraints): these deliberately block
 * non-browser clients and we do not UA-spoof to defeat that. A status from one of these hosts
 * is not a parser bug and the report says so explicitly, so a human scanning the output does
 * not waste time looking at a parser that was never given a chance to run.
 */
const DECLINED_HOSTS = new Set([
  'yasme.org',
  'www.yasme.org',
  'ncdxf.org',
  'www.ncdxf.org',
  'radioclubofamerica.org',
  'www.radioclubofamerica.org',
  'mga.ieee.org',
  'k9ona.com',
  'www.k9ona.com',
]);

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function declinedNote(url: string, status: number | 'error'): string | undefined {
  const host = hostOf(url);
  if (!host || !DECLINED_HOSTS.has(host)) return undefined;
  if (status === 418) return `declined by the site (HTTP 418 "I'm a teapot" — ${host} refuses non-browser clients; expected, not a parser bug)`;
  if (status === 'error' || (typeof status === 'number' && (status === 403 || status === 401 || status >= 400))) {
    return `declined by the site (${host} refuses non-browser clients; expected, not a parser bug)`;
  }
  return undefined;
}

export function formatVerifyReport(rows: VerifyRow[]): string {
  const lines = rows.map((r) => {
    const flag = r.ok ? ' ok  ' : 'WARN ';
    const yieldText = `${r.parsedCount}/${r.expectedMinRecords}`;
    return `${flag} ${r.sourceId.padEnd(40)} ${String(r.status).padStart(5)} ${yieldText.padStart(9)}  ${r.note}`.trimEnd();
  });
  const warnings = rows.filter((r) => !r.ok).length;
  lines.push('');
  lines.push(
    `${rows.length} sources checked, ${warnings} warning${warnings === 1 ? '' : 's'}. ` +
      'This check is warn-only and never gates a build.',
  );
  return lines.join('\n');
}

/** ALWAYS 0. The network is not a build dependency: this check never gates a build. */
export function verifyExitCode(): 0 {
  return 0;
}

export async function verifySources(fetcher: Fetcher, sourceIds?: string[]): Promise<VerifyRow[]> {
  const ids = sourceIds ?? SOURCES.map((m) => m.id);
  const rows: VerifyRow[] = [];

  for (const id of ids) {
    const module = getSource(id);
    const payloads: FetchedPayload[] = [];
    let status: number | 'error' = 200;
    let url = '';

    try {
      for (const request of await resolveRequests(module)) {
        url = url || request.url;
        const payload = await fetcher.fetch(request);
        payloads.push(payload);
        if (payload.status < 200 || payload.status >= 300) status = payload.status;
      }
      if (hasFollowUp(module)) {
        for (const request of module.followUp(payloads)) {
          const payload = await fetcher.fetch(request);
          payloads.push(payload);
          if (payload.status < 200 || payload.status >= 300) status = payload.status;
        }
      }
    } catch {
      status = 'error';
    }

    let parsedCount = 0;
    try {
      parsedCount = module.parse(payloads).length;
    } catch {
      status = 'error';
    }

    const row = verifyRowFor(id, status, parsedCount, module.expectedMinRecords, url, module.tier);
    const declined = declinedNote(url, status);
    rows.push(declined ? { ...row, note: declined } : row);
  }

  return rows;
}
