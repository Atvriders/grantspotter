export interface RobotsRules {
  /** Allow patterns from EVERY matching user-agent group, in file order. */
  allows: string[];
  /** Disallow patterns from EVERY matching user-agent group, in file order. */
  disallows: string[];
  /** The LONGEST Crawl-delay any matching group asked for. See `parseRobots`. */
  crawlDelaySec?: number;
  status: number;
  fetchedAt: string;
  /**
   * Did we learn this origin's rules, or only fail to?
   *
   * TWO DIFFERENT THINGS PRODUCE `disallows: ['/']` and they must not be stored alike. A file that
   * says `Disallow: /` is a site owner's decision and is worth believing for as long as any other
   * file; a 503, a dropped connection or a redirect chain that never resolved is our own failure to
   * read, and believing it for six hours punishes the site for a blip. It also has to be possible
   * to say which one happened without inferring it from a status code, because `status` is 0 in the
   * one case there was no HTTP response at all.
   *
   * True for a 200 we parsed AND for a 4xx that is not 429 — "this site publishes no rules" is a
   * real answer, and it is the one ncdxf.org gives by 403ing its own robots.txt. False for 429, 5xx,
   * an unresolved redirect chain, and any transport failure.
   */
  wasRead: boolean;
}

/**
 * The verdict for an origin whose rules we never obtained.
 *
 * `disallows: ['/']`, because a read we could not complete is not permission — see the enumeration
 * on {@link robotsFromResponse}. `status: 0`, because there was no HTTP response to record: this is
 * the connection that was refused, reset, or timed out after every retry.
 */
export function robotsUnread(fetchedAt: string): RobotsRules {
  return { allows: [], disallows: ['/'], status: 0, fetchedAt, wasRead: false };
}

export const ROBOTS_ALLOW_ALL: RobotsRules = Object.freeze({
  allows: [],
  disallows: [],
  status: 0,
  fetchedAt: '1970-01-01T00:00:00.000Z',
  // A stated absence of rules, not a failed read: this constant is what "the site published nothing
  // and that is fine" looks like, which is the same posture a 404 produces.
  wasRead: true,
});

export class RobotsDisallowedError extends Error {
  readonly url: string;
  constructor(url: string) {
    super(`robots.txt disallows ${url}`);
    this.name = 'RobotsDisallowedError';
    this.url = url;
  }
}

interface Group {
  agents: string[];
  allows: string[];
  disallows: string[];
  crawlDelaySec?: number;
}

function stripComment(line: string): string {
  const hash = line.indexOf('#');
  return (hash === -1 ? line : line.slice(0, hash)).trim();
}

/**
 * Does one `User-agent:` value in a robots.txt name US?
 *
 * Both arguments arrive lower-cased — `parseRobots` folds the file's values as it reads them and
 * folds our token once — because RFC 9309 §2.2.1 defines the product token as case-insensitive,
 * and the README and the issue template now say so where a site owner can read it.
 *
 * THIS USED TO BE `token.includes(value)`, i.e. the value in the FILE had to be a substring of the
 * string `grantspotter`, and it was wrong in both directions at once:
 *
 *   FALSE NEGATIVE, and this is the one that mattered. `User-agent: GrantSpotter/0.1.0` did not
 *   match, because `grantspotter` does not contain `grantspotter/0.1.0`. That is the token exactly
 *   as this crawler prints it in the log line the issue template quotes TWELVE LINES ABOVE the
 *   paragraph telling a site owner to put it in robots.txt. A person who copied what they were
 *   shown was not stopped, was told they would be, and got no signal either way — the polling just
 *   continued. Measured before the fix, against the real parser:
 *
 *     User-agent: GrantSpotter/0.1.0 / Disallow: /   ->  isPathAllowed(rules, '/grants') === true
 *
 *   FALSE POSITIVE. `User-agent: grant` DID match, because `grantspotter` contains `grant`. Rules
 *   written for somebody else's crawler — a Crawl-delay, a Disallow — were obeyed as if they were
 *   addressed to us.
 *
 * The rule now: the value IS the token, or it is the token followed by a character that is not a
 * letter or a digit. That accepts every form a person types after reading a log line —
 * `GrantSpotter`, `GrantSpotter/0.1.0`, `grantspotter-bot`, `GrantSpotter_crawler` — and refuses
 * `grantspotterbot`, a different product whose name merely begins with ours. (`*` is not handled
 * here; it is the fallback group, and `parseRobots` only reaches it when nothing named us.)
 *
 * Where the two directions of error trade off, this leans towards obeying, deliberately: a
 * separator we failed to anticipate costs us one source for one night, and a rule we failed to
 * honour costs a volunteer-run site the only remedy this project promises it.
 */
function namesUs(agentValue: string, token: string): boolean {
  if (!agentValue.startsWith(token)) return false;
  if (agentValue.length === token.length) return true;
  return !/[a-z0-9]/.test(agentValue.charAt(token.length));
}

/*
 * WHAT ENDS A RUN OF `User-agent:` LINES — a RULE, and nothing else.
 *
 * RFC 9309 §2.1 spells the grammar out:
 *
 *     group = startgroupline *(startgroupline / emptyline) *(rule / emptyline)
 *
 * so consecutive `User-agent:` lines are ONE group, and an empty line between them does not end
 * the run. §2.2.4 then says a crawler may see records that are not part of the protocol at all —
 * `Sitemap:` is the example the RFC itself gives — and §2.1 strips `#` comments before any of this
 * is read. None of the three is a rule, so none of them may split a group.
 *
 * This used to reset the flag on a blank line and again on EVERY line that was not a `User-agent:`,
 * which meant all three did. Measured against the parser before the fix, on a file whose only sin
 * is a sitemap line where a sitemap line normally goes:
 *
 *     User-agent: GrantSpotter
 *     Sitemap: https://example.org/sitemap.xml
 *     User-agent: *
 *     Disallow: /
 *
 *   -> two groups, the named one empty, the wildcard one holding the Disallow. A named group beats
 *      the wildcard, so the empty one won and `isPathAllowed('/anything')` was true. The site said
 *      "GrantSpotter, and everyone else, keep out" and we read it as "no rules for GrantSpotter".
 *
 * A blank line and a comment between two `User-agent:` lines produced the same split. All three
 * shapes are ordinary in real robots.txt files, and the failure is the dangerous kind: it looks
 * obeyed, because the rules are still there — just in a group nothing matches.
 */
export function parseRobots(
  body: string,
  agentToken: string,
  status: number,
  fetchedAt: string,
): RobotsRules {
  const groups: Group[] = [];
  let current: Group | null = null;
  let inAgentRun = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = stripComment(rawLine);
    // A blank line — or a line that was nothing but a comment, which `stripComment` has just made
    // blank — is `emptyline` in the ABNF above. It appears INSIDE a group there, so it decides
    // nothing.
    if (line === '') continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === 'user-agent') {
      if (!current || !inAgentRun) {
        current = { agents: [], allows: [], disallows: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      inAgentRun = true;
      continue;
    }
    if (!current) continue;
    if (field === 'disallow') {
      inAgentRun = false;
      if (value !== '') current.disallows.push(value);
      continue;
    }
    if (field === 'allow') {
      inAgentRun = false;
      if (value !== '') current.allows.push(value);
      continue;
    }
    if (field === 'crawl-delay') {
      // Not in the RFC's `rule` production — it is an "other record" per §2.2.4 — but this parser
      // has always treated it as belonging to the group above it, and a site that writes
      // `Crawl-delay:` between two `User-agent:` lines has plainly finished naming agents.
      inAgentRun = false;
      const n = Number.parseFloat(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelaySec = n;
      continue;
    }
    // Anything else — `Sitemap:`, `Host:`, a typo — is an unrecognised record. It is not a rule, so
    // it does not end the run of agents, and it is not ours, so it is dropped.
  }

  /*
   * EVERY matching group, not the first one.
   *
   * RFC 9309 §2.2.1: "If more than one group matches, the matching groups' rules MUST be merged
   * into one group." This was `groups.find(...)`, which took the first and dropped the rest.
   * Measured before the fix, on a file that says the same thing twice:
   *
   *     User-agent: GrantSpotter      User-agent: GrantSpotter
   *     Crawl-delay: 30               Disallow: /
   *
   *   -> crawlDelaySec 30, disallows [], isPathAllowed('/grants') === true
   *
   * We waited thirty seconds and then fetched a page the file had just forbidden. Splitting rules
   * across two groups with the same agent is a completely ordinary way to write a robots.txt — a
   * generic block plus a later, hand-added one — and the shape of the failure is the worst
   * available: it looks like the file is being obeyed, because half of it is.
   *
   * A named group still beats the wildcard outright (RFC 9309 §2.2.1 again: the most specific
   * match applies, and `*` is the least specific), so a site that writes rules for us is not also
   * held to the rules it wrote for everybody.
   */
  const token = agentToken.toLowerCase();
  const named = groups.filter((g) => g.agents.some((a) => namesUs(a, token)));
  const matching = named.length > 0 ? named : groups.filter((g) => g.agents.includes('*'));

  const delays = matching
    .map((g) => g.crawlDelaySec)
    .filter((delay): delay is number => delay !== undefined);

  return {
    wasRead: true,
    allows: matching.flatMap((g) => g.allows),
    disallows: matching.flatMap((g) => g.disallows),
    // The LONGEST delay any matching group asked for. Two groups naming different intervals is a
    // file that contradicts itself, and when a site owner's intent is ambiguous the reading to
    // take is the one that polls less.
    crawlDelaySec: delays.length > 0 ? Math.max(...delays) : undefined,
    status,
    fetchedAt,
  };
}

/**
 * EVERY status class, which is the point. The list below is exhaustive over 1xx–5xx, and it is
 * written that way because the previous version of this comment enumerated 200 / 4xx / 429 / 5xx,
 * never mentioned 3xx, and the code matched the comment: a redirect fell through to the final
 * `return` and became ALLOW-ALL. A 301 on `/robots.txt` — apex to `www`, or http to https, which
 * is what a small nonprofit's hosting does by default — was read as "this site publishes no rules,
 * crawl it". A crawler that treats a redirect as permission is precisely the failure this
 * product's politeness story exists to avoid, and the gap survived because an enumeration with a
 * hole in it reads like an enumeration.
 *
 * 200 — parse it.
 *
 * 3xx — the caller (`createFetcher`'s `readRobots`) follows up to ROBOTS_MAX_REDIRECTS hops and
 * calls this with whatever the chain ends at, so a 3xx arriving HERE means the chain did not end:
 * too many hops, no `Location`, a `Location` that will not parse, or one pointing at a host the
 * blocklist refuses. In every one of those we did not read the site's rules, so we do not get to
 * assume they permit us: back off for this run. RFC 9309 §2.3.1.2 would instead assume "no
 * robots.txt" after five redirects; this deviates from it in the direction of polling less, and
 * the cost is bounded — one run, then the next crawl re-reads.
 *
 * 4xx other than 429 means "no rules are published" — crawl freely. ncdxf.org 403s its own
 * robots.txt, and treating that as disallow-all would silently drop the source forever.
 * 429 and 5xx mean the server is unhappy: back off and treat it as disallow-all until the
 * next nightly poll re-reads it.
 *
 * THAT LAST CLAUSE WAS FALSE UNTIL 2026-08-04, and it is worth saying why it is true now rather
 * than just correcting it. The caller cached this result in a `Map` keyed by origin with no
 * expiry and no eviction, so "until the next nightly poll re-reads it" described an intention
 * nothing implemented: a 503 at 03:17 disallowed the whole origin for the life of the process, and
 * so did a `Disallow: /` that a site later removed. The re-read now exists — `runCrawl` calls
 * `Fetcher.forgetRobots()` at the start of every run, and `ROBOTS_CACHE_TTL_MS` bounds every other
 * path — so this function's back-off really is for one run, and the remedy this project tells site
 * owners to use really does take effect the next night.
 */
export function robotsFromResponse(
  status: number,
  body: string,
  agentToken: string,
  fetchedAt: string,
): RobotsRules {
  if (status === 200) return parseRobots(body, agentToken, status, fetchedAt);
  if (status === 429 || status >= 500) {
    return { allows: [], disallows: ['/'], status, fetchedAt, wasRead: false };
  }
  if (status >= 300 && status < 400) {
    return { allows: [], disallows: ['/'], status, fetchedAt, wasRead: false };
  }
  // A 4xx that is not 429. The site answered, and the answer is "there is nothing here", which is a
  // real reading of its rules rather than a failure to obtain them — hence `wasRead: true`, and
  // hence this verdict keeps the full cache lifetime while the two above do not.
  return { allows: [], disallows: [], status, fetchedAt, wasRead: true };
}

/**
 * How many redirects a `robots.txt` is followed through. RFC 9309 §2.3.1.2 requires at least five,
 * "even across authorities" — the rules that come back apply to the origin we asked, not to
 * whatever origin answered.
 *
 * Not configurable, unlike `FetchOptions.maxRedirects`, which governs ordinary page fetches: this
 * one is a floor an RFC sets on being polite, and an operator turning it down would be turning
 * down the site owner's ability to be heard.
 */
export const ROBOTS_MAX_REDIRECTS = 5;

function patternToRegExp(pattern: string): RegExp {
  let anchored = false;
  let p = pattern;
  if (p.endsWith('$')) {
    anchored = true;
    p = p.slice(0, -1);
  }
  const body = p
    .split('*')
    .map((chunk) => chunk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

function matchLength(patterns: string[], pathWithQuery: string): number {
  let best = -1;
  for (const pattern of patterns) {
    if (patternToRegExp(pattern).test(pathWithQuery)) {
      const len = pattern.replace(/\$$/, '').length;
      if (len > best) best = len;
    }
  }
  return best;
}

/** Longest match wins; on a tie, Allow wins. */
export function isPathAllowed(rules: RobotsRules, pathWithQuery: string): boolean {
  const path = pathWithQuery.startsWith('/') ? pathWithQuery : `/${pathWithQuery}`;
  const allow = matchLength(rules.allows, path);
  const disallow = matchLength(rules.disallows, path);
  if (disallow === -1) return true;
  return allow >= disallow;
}
