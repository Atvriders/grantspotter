export interface RobotsRules {
  /** Allow patterns from the winning user-agent group, in file order. */
  allows: string[];
  /** Disallow patterns from the winning user-agent group, in file order. */
  disallows: string[];
  crawlDelaySec?: number;
  status: number;
  fetchedAt: string;
}

export const ROBOTS_ALLOW_ALL: RobotsRules = Object.freeze({
  allows: [],
  disallows: [],
  status: 0,
  fetchedAt: '1970-01-01T00:00:00.000Z',
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

export function parseRobots(
  body: string,
  agentToken: string,
  status: number,
  fetchedAt: string,
): RobotsRules {
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastLineWasAgent = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = stripComment(rawLine);
    if (line === '') {
      lastLineWasAgent = false;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === 'user-agent') {
      if (!current || !lastLineWasAgent) {
        current = { agents: [], allows: [], disallows: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastLineWasAgent = true;
      continue;
    }
    lastLineWasAgent = false;
    if (!current) continue;
    if (field === 'disallow') {
      if (value !== '') current.disallows.push(value);
      continue;
    }
    if (field === 'allow') {
      if (value !== '') current.allows.push(value);
      continue;
    }
    if (field === 'crawl-delay') {
      const n = Number.parseFloat(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelaySec = n;
    }
  }

  const token = agentToken.toLowerCase();
  const named = groups.find((g) => g.agents.some((a) => a !== '*' && token.includes(a)));
  const wildcard = groups.find((g) => g.agents.includes('*'));
  const winner = named ?? wildcard;

  return {
    allows: winner ? [...winner.allows] : [],
    disallows: winner ? [...winner.disallows] : [],
    crawlDelaySec: winner?.crawlDelaySec,
    status,
    fetchedAt,
  };
}

/**
 * 4xx other than 429 means "no rules are published" — crawl freely. ncdxf.org 403s its own
 * robots.txt, and treating that as disallow-all would silently drop the source forever.
 * 429 and 5xx mean the server is unhappy: back off and treat it as disallow-all until the
 * next nightly poll re-reads it.
 */
export function robotsFromResponse(
  status: number,
  body: string,
  agentToken: string,
  fetchedAt: string,
): RobotsRules {
  if (status === 200) return parseRobots(body, agentToken, status, fetchedAt);
  if (status === 429 || status >= 500) {
    return { allows: [], disallows: ['/'], status, fetchedAt };
  }
  return { allows: [], disallows: [], status, fetchedAt };
}

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
