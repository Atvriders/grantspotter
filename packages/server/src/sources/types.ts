import type { FetchRequest, FetchedPayload, RawOpportunity, SourceModule } from '@grantspotter/core';

/**
 * Some sources cannot express their real request set statically. ARDC is the canonical case:
 * the child-page query needs a parent page ID that must be resolved at runtime (ARDC has no
 * grant custom-post-type; grants are hierarchical WordPress pages, and hardcoding the ID
 * breaks the moment they re-publish the page).
 *
 * A follow-up source is still pure: followUp() is a pure function of the first-phase payloads.
 * The crawl runner performs the second fetch.
 */
export interface FollowUpContext {
  /** Last successful poll for this source, used for `modified_after`-style incremental queries. */
  sinceISO?: string;
}

export interface FollowUpSource extends SourceModule {
  followUp(payloads: FetchedPayload[], ctx?: FollowUpContext): FetchRequest[];
}

/**
 * A change-signal source. arrl.org/news/rss carries grant and deadline announcements but no
 * structured opportunities, so it produces ChangeEvents for a human to read and never
 * produces candidate Programs.
 */
export interface SignalSource extends SourceModule {
  signalOnly: true;
  isRelevant(raw: RawOpportunity): boolean;
}

export function hasFollowUp(m: SourceModule): m is FollowUpSource {
  return typeof (m as Partial<FollowUpSource>).followUp === 'function';
}

export function isSignalSource(m: SourceModule): m is SignalSource {
  return (m as Partial<SignalSource>).signalOnly === true;
}

export async function resolveRequests(m: SourceModule): Promise<FetchRequest[]> {
  return typeof m.requests === 'function' ? m.requests() : m.requests;
}
