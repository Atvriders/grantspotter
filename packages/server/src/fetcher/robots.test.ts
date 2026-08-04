import { describe, expect, it } from 'vitest';
import { ROBOTS_MAX_REDIRECTS, isPathAllowed, parseRobots, robotsFromResponse } from './robots.js';

const NOW = '2026-08-02T00:00:00.000Z';

// Shape of arrl.org/robots.txt as observed 2026-08-02.
const ARRL_ROBOTS = `User-agent: *
Crawl-delay: 5
Disallow: /files/file/protected
Disallow: /attachments/download
Disallow: /admin
Disallow: /results-database
Disallow: /volunteer-monitor-resources

Sitemap: http://www.arrl.org/sitemap.xml
`;

const ARDC_ROBOTS = `User-agent: *
Disallow: /wp-admin/
Allow: /wp-admin/admin-ajax.php

Sitemap: https://www.ardc.net/wp-sitemap.xml
`;

describe('parseRobots', () => {
  it('reads arrl.org Crawl-delay: 5 from the wildcard group', () => {
    const rules = parseRobots(ARRL_ROBOTS, 'GrantSpotter', 200, NOW);
    expect(rules.crawlDelaySec).toBe(5);
  });

  it('allows every ARRL grant and scholarship path', () => {
    const rules = parseRobots(ARRL_ROBOTS, 'GrantSpotter', 200, NOW);
    for (const p of [
      '/scholarship-descriptions',
      '/amateur-radio-grants',
      '/club-grant-program',
      '/etp-grants',
      '/news/rss',
    ]) {
      expect(isPathAllowed(rules, p)).toBe(true);
    }
  });

  it('honours every ARRL disallow, including deeper paths under it', () => {
    const rules = parseRobots(ARRL_ROBOTS, 'GrantSpotter', 200, NOW);
    for (const p of [
      '/admin',
      '/admin/users',
      '/files/file/protected/x.pdf',
      '/attachments/download?id=3',
      '/results-database',
      '/volunteer-monitor-resources',
    ]) {
      expect(isPathAllowed(rules, p)).toBe(false);
    }
  });

  it('lets a longer Allow beat a shorter Disallow', () => {
    const rules = parseRobots(ARDC_ROBOTS, 'GrantSpotter', 200, NOW);
    expect(isPathAllowed(rules, '/wp-admin/')).toBe(false);
    expect(isPathAllowed(rules, '/wp-admin/admin-ajax.php')).toBe(true);
    expect(isPathAllowed(rules, '/apply/grants/2026-grants/')).toBe(true);
    expect(isPathAllowed(rules, '/wp-json/wp/v2/pages?slug=grants')).toBe(true);
  });

  it('prefers a group naming our token over the wildcard group', () => {
    const body = `User-agent: *
Disallow: /

User-agent: GrantSpotter
Crawl-delay: 2
Disallow: /private
`;
    const rules = parseRobots(body, 'GrantSpotter', 200, NOW);
    expect(rules.crawlDelaySec).toBe(2);
    expect(isPathAllowed(rules, '/anything')).toBe(true);
    expect(isPathAllowed(rules, '/private/x')).toBe(false);
  });

  it('supports * wildcards and $ end-anchors in patterns', () => {
    const rules = parseRobots(
      'User-agent: *\nDisallow: /*.pdf$\nDisallow: /a/*/b\n',
      'GrantSpotter',
      200,
      NOW,
    );
    expect(isPathAllowed(rules, '/files/form.pdf')).toBe(false);
    expect(isPathAllowed(rules, '/files/form.pdf?v=2')).toBe(true);
    expect(isPathAllowed(rules, '/a/zzz/b')).toBe(false);
    expect(isPathAllowed(rules, '/a/b')).toBe(true);
  });

  it('ignores comments, blank lines and unknown directives', () => {
    const rules = parseRobots(
      '# hello\nUser-agent: *\nSitemap: https://x.test/s.xml\nDisallow: /q # trailing\n',
      'GrantSpotter',
      200,
      NOW,
    );
    expect(isPathAllowed(rules, '/q')).toBe(false);
    expect(isPathAllowed(rules, '/r')).toBe(true);
  });

  it('treats an empty Disallow value as allow-all for that directive', () => {
    const rules = parseRobots('User-agent: *\nDisallow:\n', 'GrantSpotter', 200, NOW);
    expect(isPathAllowed(rules, '/anything/at/all')).toBe(true);
  });

  it('defaults to allow-all when a matched group has no Disallow directives', () => {
    const rules = parseRobots('User-agent: *\nAllow: /public\n', 'GrantSpotter', 200, NOW);
    expect(isPathAllowed(rules, '/public')).toBe(true);
    // An Allow-only group is not an implicit whitelist: nothing was disallowed.
    expect(isPathAllowed(rules, '/private-but-never-disallowed')).toBe(true);
  });

  it('applies longest-match precedence, not file order or Allow-always-wins', () => {
    const rules = parseRobots(
      'User-agent: *\nAllow: /a\nDisallow: /a/private\n',
      'GrantSpotter',
      200,
      NOW,
    );
    expect(isPathAllowed(rules, '/a/public')).toBe(true);
    expect(isPathAllowed(rules, '/a/private')).toBe(false);
    expect(isPathAllowed(rules, '/a/private/x')).toBe(false);
  });

  it('parses a fractional Crawl-delay', () => {
    const rules = parseRobots('User-agent: *\nCrawl-delay: 2.5\n', 'GrantSpotter', 200, NOW);
    expect(rules.crawlDelaySec).toBe(2.5);
  });

  it('parses CRLF line endings identically to LF', () => {
    const crlf = ARRL_ROBOTS.replace(/\n/g, '\r\n');
    const rules = parseRobots(crlf, 'GrantSpotter', 200, NOW);
    expect(rules.crawlDelaySec).toBe(5);
    expect(isPathAllowed(rules, '/admin')).toBe(false);
    expect(isPathAllowed(rules, '/amateur-radio-grants')).toBe(true);
  });

  it('degrades to allow-all when the body is an HTML error page instead of robots directives', () => {
    // Several sites in this corpus 200 (or error-status) a themed HTML page from the
    // robots.txt URL instead of real directives. No line contains a recognised field,
    // so no group is ever opened and the result carries no rules — same posture as a
    // missing robots.txt, which costs us nothing since no restriction was ever stated.
    const html = [
      '<!DOCTYPE html>',
      '<html><head><title>403 Forbidden</title></head>',
      '<body><p>You do not have permission to access this resource.</p></body>',
      '</html>',
    ].join('\n');
    const rules = parseRobots(html, 'GrantSpotter', 200, NOW);
    expect(rules.allows).toEqual([]);
    expect(rules.disallows).toEqual([]);
    expect(isPathAllowed(rules, '/pages/grant-app.html')).toBe(true);
  });
});

/**
 * THE TOKEN A SITE OWNER IS TOLD TO WRITE, and whether writing it works.
 *
 * This is the load-bearing test in the file. The README and
 * `.github/ISSUE_TEMPLATE/crawler-contact.md` both promise a stranger that `robots.txt` is the one
 * remedy that stops every deployment of this software, and the issue template quotes the crawler's
 * log line — `GrantSpotter/0.1.0 (+…)` — twelve lines above the paragraph saying so. Until
 * 2026-08-04 the match was `agentToken.includes(fileValue)`, so the string the reader had just
 * been SHOWN was the one string that did not stop us, and a short unrelated name did.
 */
describe('the agent token a site owner is told to write', () => {
  const stopsUs = (value: string): boolean =>
    !isPathAllowed(
      parseRobots(`User-agent: ${value}\nDisallow: /\n`, 'GrantSpotter', 200, NOW),
      '/amateur-radio-grants',
    );

  it('obeys the token exactly as the crawler prints it in a log line', () => {
    expect(stopsUs('GrantSpotter/0.1.0')).toBe(true);
  });

  it('is case-insensitive, which is what RFC 9309 §2.2.1 says a product token is', () => {
    for (const value of ['GrantSpotter', 'grantspotter', 'GRANTSPOTTER', 'GrAnTsPoTtEr']) {
      expect(stopsUs(value), value).toBe(true);
    }
  });

  it('accepts any non-alphanumeric separator after the token', () => {
    // Every shape a person plausibly types after reading a log line or a blog post.
    for (const value of [
      'GrantSpotter/0.1.0',
      'grantspotter-bot',
      'GrantSpotter_crawler',
      'GrantSpotter (nightly grant-deadline change detector)',
      'grantspotter.bot',
      'GrantSpotter+https://github.com/Atvriders/grantspotter',
    ]) {
      expect(stopsUs(value), value).toBe(true);
    }
  });

  it('does not obey rules addressed to somebody else', () => {
    // Every one of these matched before 2026-08-04, because each is a SUBSTRING of `grantspotter`.
    // Honouring a Disallow written for `grant` is not politeness; it is reading somebody's mail.
    for (const value of ['grant', 'spot', 'g', 'pot', 'rants', 'otter']) {
      expect(stopsUs(value), value).toBe(false);
    }
  });

  it('does not match a longer name that merely begins the same way', () => {
    for (const value of ['grantspotterbot', 'GrantSpotter2', 'grantspotterly']) {
      expect(stopsUs(value), value).toBe(false);
    }
  });

  it('still honours the wildcard, and a Crawl-delay written for us', () => {
    expect(stopsUs('*')).toBe(true);
    const rules = parseRobots('User-agent: grantspotter/0.1.0\nCrawl-delay: 20\n', 'GrantSpotter', 200, NOW);
    expect(rules.crawlDelaySec).toBe(20);
  });
});

/**
 * RFC 9309 §2.2.1: "If more than one group matches, the matching groups' rules MUST be merged."
 * This took `groups.find`, i.e. the first, and the shape of the failure was the worst available —
 * it looked obeyed, because half of it was.
 */
describe('every group whose token matches applies', () => {
  it('merges a Crawl-delay group and a Disallow group naming the same agent', () => {
    const body = `User-agent: GrantSpotter
Crawl-delay: 30

User-agent: GrantSpotter
Disallow: /
`;
    const rules = parseRobots(body, 'GrantSpotter', 200, NOW);
    // Measured before the fix: delay 30, disallows [], and the page fetched thirty seconds later.
    expect(rules.crawlDelaySec).toBe(30);
    expect(rules.disallows).toEqual(['/']);
    expect(isPathAllowed(rules, '/amateur-radio-grants')).toBe(false);
  });

  it('merges groups that name us in different spellings', () => {
    const body = `User-agent: grantspotter
Disallow: /a

User-agent: GrantSpotter/0.1.0
Disallow: /b
`;
    const rules = parseRobots(body, 'GrantSpotter', 200, NOW);
    expect(isPathAllowed(rules, '/a')).toBe(false);
    expect(isPathAllowed(rules, '/b')).toBe(false);
  });

  it('takes the longest Crawl-delay when two matching groups disagree', () => {
    const body = `User-agent: grantspotter
Crawl-delay: 2

User-agent: GrantSpotter-bot
Crawl-delay: 45
`;
    // A file contradicting itself is a site owner whose intent is unclear, and the reading to take
    // is the one that polls less.
    expect(parseRobots(body, 'GrantSpotter', 200, NOW).crawlDelaySec).toBe(45);
  });

  it('merges wildcard groups too, when nothing names us', () => {
    const rules = parseRobots(
      'User-agent: *\nDisallow: /a\n\nUser-agent: *\nDisallow: /b\n',
      'GrantSpotter',
      200,
      NOW,
    );
    expect(isPathAllowed(rules, '/a')).toBe(false);
    expect(isPathAllowed(rules, '/b')).toBe(false);
  });

  it('still lets a named group beat the wildcard outright', () => {
    // Merging is within a specificity level, not across it: a site that wrote rules for us is not
    // also held to the ones it wrote for everybody.
    const rules = parseRobots(
      'User-agent: *\nDisallow: /\n\nUser-agent: GrantSpotter\nDisallow: /private\n',
      'GrantSpotter',
      200,
      NOW,
    );
    expect(isPathAllowed(rules, '/amateur-radio-grants')).toBe(true);
    expect(isPathAllowed(rules, '/private')).toBe(false);
  });
});

describe('robotsFromResponse', () => {
  it('treats a 403 as "no rules published" — ncdxf.org 403s its own robots.txt', () => {
    // ncdxf.org serves a meta-refresh HTML page (not real robots directives) alongside
    // the 403. The status alone drives the decision — the body is never even parsed.
    const metaRefreshBody =
      '<html><head><meta http-equiv="refresh" content="0; url=/error.html"></head><body>Forbidden</body></html>';
    const rules = robotsFromResponse(403, metaRefreshBody, 'GrantSpotter', NOW);
    expect(isPathAllowed(rules, '/pages/grant-app.html')).toBe(true);
  });

  it('treats 404 the same way', () => {
    expect(isPathAllowed(robotsFromResponse(404, '', 'GrantSpotter', NOW), '/anything')).toBe(true);
  });

  it('treats 429 and 5xx as back-off: disallow everything until the next poll', () => {
    for (const status of [429, 500, 502, 503]) {
      const rules = robotsFromResponse(status, '', 'GrantSpotter', NOW);
      expect(isPathAllowed(rules, '/anything')).toBe(false);
    }
  });

  it('parses a 200 body normally', () => {
    const rules = robotsFromResponse(200, ARRL_ROBOTS, 'GrantSpotter', NOW);
    expect(rules.crawlDelaySec).toBe(5);
  });

  it('never reads a redirect as permission', () => {
    // The caller follows up to ROBOTS_MAX_REDIRECTS hops, so a 3xx arriving here means the chain
    // did not resolve. Until 2026-08-04 there was no 3xx branch at all: a 301 fell through to the
    // 4xx path and became allow-all, so a site whose /robots.txt redirects — apex to www, http to
    // https, the default of most hosting a small nonprofit uses — was crawled as though it had
    // published nothing. That is the exact failure this product's politeness story exists around.
    for (const status of [301, 302, 303, 307, 308]) {
      const rules = robotsFromResponse(status, '', 'GrantSpotter', NOW);
      expect(isPathAllowed(rules, '/amateur-radio-grants'), String(status)).toBe(false);
    }
  });

  it('gives the redirect budget RFC 9309 §2.3.1.2 asks for', () => {
    expect(ROBOTS_MAX_REDIRECTS).toBeGreaterThanOrEqual(5);
  });
});
