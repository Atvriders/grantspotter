import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PLACEHOLDER_MARKER } from '../config.js';

/**
 * A README is the first thing that rots, and this one carries the two claims whose absence would
 * make the whole project dishonest: that this is a curated database rather than a spider, and that
 * the AI feature composes a prompt rather than writing an application. Both are asserted here so
 * that a future edit that quietly upgrades the marketing fails the suite instead of shipping.
 *
 * The numbers are not decoration. `150 publishable`, `111` from one page, `243` cycles and `4`
 * funder-stated dates are the figures `scripts/profile-corpus.ts`,
 * `packages/server/src/api/exportsCorpus.test.ts` and `packages/server/src/exports/ics.test.ts`
 * measure against the committed fixtures. If the corpus moves, those suites go red first and this
 * one goes red immediately after, which is the intended order.
 *
 * The last test is the one that keeps the instructions runnable: every `npm run <script>` printed
 * in the README must exist in the root package.json. A README that documents a script nobody
 * renamed back is the cheapest possible broken promise.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
const readme = readFileSync(resolve(REPO_ROOT, 'README.md'), 'utf8');
const rootPkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

describe('README honesty surfaces', () => {
  it('says plainly that this is a curated database, not a spider', () => {
    expect(readme).toMatch(/curated database with a change-detection layer, not a spider/i);
  });

  it('states the corpus size, the concentration and the single real API', () => {
    expect(readme).toMatch(/150 records/);
    // The brief's draft said "75%". The measured figure against the committed fixtures is
    // 111 of 150 = 74%, so the README prints the count and the rounded share it actually is.
    expect(readme).toMatch(/111 of the 150/);
    expect(readme).toMatch(/three-quarters/i);
    expect(readme).toMatch(/ARDC/);
    expect(readme).toMatch(/exactly one/i);
  });

  it('separates the 150 published records from the 553 that are stored and hidden', () => {
    expect(readme).toMatch(/553/);
    expect(readme).toMatch(/past awards?/i);
  });

  it('documents the blocklist and why each host is on it', () => {
    for (const host of [
      'farweb.org',
      'candid.org',
      'grantwatch.com',
      'grantstation.com',
      'instrumentl.com',
    ]) {
      expect(readme).toContain(host);
    }
    expect(readme).toMatch(/gambling/i);
    expect(readme).toMatch(/ClaudeBot/);
    expect(readme).toMatch(/survives termination/i);
    expect(readme).toMatch(/not configurable|cannot be disabled by configuration/i);
  });

  it('describes the AI feature accurately and says what the server does not do', () => {
    expect(readme).toContain('Copy AI Prompt — includes AI-detection avoidance');
    expect(readme).toMatch(/does not (draft|write)/i);
    expect(readme).toMatch(/never on the read path/i);
    expect(readme).toMatch(/no funder found prohibits applicants from using AI/i);
  });

  it('repeats the prompt’s own disclaimer instead of implying detector evasion', () => {
    expect(readme).toMatch(
      /nothing in this brief will make an AI-detection classifier report "human"/i,
    );
    expect(readme).toMatch(/Kobak/);
    expect(readme).toMatch(/66% verbs/);
    expect(readme).toMatch(/79% nouns/);
  });

  it('says what the fact checklist cannot do', () => {
    expect(readme).toMatch(/fact checklist/i);
    expect(readme).toMatch(/superlative/i);
    expect(readme).toMatch(/cannot (list|enumerate)/i);
  });

  it('counts the writing tools it actually ships', () => {
    expect(readme).toMatch(/13 (application )?components?/i);
    expect(readme).toMatch(/nine funder overlays/i);
    expect(readme).toMatch(/52/);
  });

  /**
   * This test used to REQUIRE the README to say "243" and "4 of the 243", and that is how a false
   * statistic survived on the project's front page with a green suite pointing at it.
   *
   * The number was wrong three separate ways for the corpus a reader installs: it named "two
   * federal NOFOs" among the funder-published windows and no federal record in this corpus
   * declares one; the ratio was measured against the test fixtures rather than the shipped seed;
   * and the total is not a constant at all, because a cycle count is a function of the corpus AND
   * the wall clock — a window that closes stops resolving, so the same corpus yielded 252/2 on
   * 2026-08-04 and 248/0 by 2027-02-01.
   *
   * So the assertion is now on the claim that is durably true and is the one that actually protects
   * a user: the README must say these dates are PROJECTED and must not quote a corpus count it
   * cannot keep true. A doc gate should pin the honesty, never the arithmetic.
   */
  it('marks the projected calendar dates as projected, without quoting a count that rots', () => {
    expect(readme).toMatch(/projected|recurrence/i);
    expect(readme).toMatch(/three seed records/i);
    expect(
      /\b(4|four) of (the )?24\d\b/i.test(readme),
      'The README is quoting a fixed "N of M cycles" statistic again. It cannot stay true: the ' +
        'count depends on the corpus and on the day it is read.',
    ).toBe(false);
  });

  it('explains why there is no headless browser', () => {
    expect(readme).toMatch(/headless (Chromium|browser)/i);
    expect(readme).toMatch(/400\s?MB/i);
  });

  it('documents every environment variable, and the two that have no default', () => {
    for (const key of [
      'HOST_PORT',
      'PORT',
      'SESSION_SECRET',
      'CONTACT_URL',
      'DATA_DIR',
      'CRAWL_ENABLED',
      'CRAWL_CRON',
      'ANTHROPIC_API_KEY',
      'SIMPLER_GRANTS_API_KEY',
    ]) {
      expect(readme).toContain(key);
    }
    // Both of them, in the table and in the prose beneath it.
    expect(readme).toMatch(/\*\*no default\*\*[\s\S]*\*\*no default\*\*/);
    expect(readme).toMatch(/Two variables fail loudly on startup/);
    expect(readme).toMatch(/32 characters/);
    expect(readme).toMatch(/User-Agent/);
  });

  /**
   * WHAT THESE GATES USED TO HOLD, AND WHY THEY HOLD THE OPPOSITE NOW.
   *
   * They were written as "does not oversell the CONTACT_URL default": the README had to print
   * `https://github.com/Atvriders/grantspotter/issues`, say that every deployment keeping it names
   * the *same* tracker, and say it is *not yours*. Every one of those assertions was right about
   * the design of the day, and every one of them is about nothing now — the owner removed the
   * default, for the reason the caveat was warning about:
   *
   *   "remove the open a issue. i don't see issues for other deployments i have no control over"
   *
   * A gate on a caveat about a default that no longer exists would pass forever while the README
   * said anything at all. So the gates move to the restored claims, and they are strictly harder to
   * satisfy than the ones they replace: the README must now state the requirement, state that it is
   * BETTER for politeness than the default was rather than merely different, keep the robots.txt
   * remedy — which matters more with no shared contact point, not less — and must not have quietly
   * left the old default lying in the prose.
   */
  it('says CONTACT_URL is required, with no default, and why there cannot be one', () => {
    expect(readme).toMatch(/`CONTACT_URL`[\s\S]{0,80}no default/);
    expect(readme).toMatch(/refuses to start without/i);
    // The reason, which is the owner's and is what decides the shape.
    expect(readme).toMatch(/cannot stop it|cannot switch/i);
    expect(readme).toMatch(/do not run/i);
    // And that this is the stronger position, not a regression dressed up.
    // `[\s\S]` and not `.`: the sentence wraps mid-phrase in the source, and a regex that assumes
    // one line would fail on a reflow that changed nothing a reader can see.
    expect(readme).toMatch(/no deployment[\s\S]{0,40}poll anonymously/i);
    expect(readme).toMatch(/hand on the switch|can actually switch that instance off/i);
  });

  it('leaves no working default lying in the prose for a reader to copy', () => {
    // The exact string that used to be REQUIRED here. A README still printing it would be handing
    // an operator an address that reaches people who cannot help them, which is the whole defect.
    expect(readme).not.toContain('https://github.com/Atvriders/grantspotter/issues');
    expect(readme).not.toMatch(/open an issue there/);
    expect(readme).not.toMatch(/leave this variable unset/i);
  });

  it('keeps the robots.txt remedy prominent, which matters more without a shared contact point', () => {
    expect(readme).toMatch(/User-agent: GrantSpotter/);
    expect(readme).toMatch(/Disallow: \//);
    // It must say what makes robots.txt the remedy: it works regardless of who runs the instance.
    expect(readme).toMatch(/no matter who is running what|regardless of who/i);
    expect(readme).toMatch(/matters more/i);
    // …and the three ways it was not honoured until 2026-08-04, since a site owner checking their
    // own logs is the only person who can tell whether it worked.
    expect(readme).toMatch(/redirects is followed/);
    expect(readme).toMatch(/stops the crawl of[\s\S]{0,20}that origin rather than being read as permission/);
    // …and the exception, because a reader who blocks us with a 403 on /robots.txt would otherwise
    // expect the crawl to stop and it does not.
    expect(readme).toMatch(/404 or 403 still means/);
    expect(readme).toMatch(/next nightly crawl/);
  });

  /**
   * THE PACING PROMISES, PINNED TO THE README THAT MAKES THEM.
   *
   * The README advertises a minimum interval per host and says `Crawl-delay` is honoured. Four
   * separate defects were measured against that, all one mistake: the per-host gate was entered
   * once per LOGICAL fetch rather than once per HTTP request, so retries and redirect hops bypassed
   * it entirely. What a reader needs is not "we are polite" but the three sentences that can be
   * checked against their own access log, so those are what this holds.
   */
  it('states the pacing rules a polled site can check against its own logs', () => {
    // The interval, as a number rather than as an adjective.
    expect(readme).toMatch(/1000 ms between requests to one host/i);
    // The unit the gate applies to, which is the whole of the defect.
    expect(readme).toMatch(/once per \*\*HTTP request\*\*|once per HTTP request/i);
    expect(readme).toMatch(/every retry, every redirect hop/i);
    // Composition, in the direction that cannot be argued into polling more.
    expect(readme).toMatch(/compose by MAX|never replace each other/i);
    // The ceiling, and that it is not the product of two limits.
    expect(readme).toMatch(/at most nine requests/i);
    expect(readme).toMatch(/not 5 x 4 = 24|rather than two that multiply/i);
    // And where the numbers came from, so the claim is reproducible rather than asserted.
    expect(readme).toMatch(/npm run measure-pacing/);
  });

  /**
   * The README sends a site owner to an issue template, so the template has to exist and has to
   * lead with the thing that works without us. A dangling link is bad; a link to a page that
   * opens by asking an annoyed stranger for information before telling them how to make the
   * problem stop is worse.
   */
  it('links an issue template that leads with the remedy, not with a request for data', () => {
    const templatePath = resolve(REPO_ROOT, '.github/ISSUE_TEMPLATE/crawler-contact.md');
    expect(readme).toContain('.github/ISSUE_TEMPLATE/crawler-contact.md');
    const template = readFileSync(templatePath, 'utf8');
    expect(template).toMatch(/^---\nname: /); // GitHub only offers it with front matter
    expect(template).toContain('User-agent: GrantSpotter');
    // The robots.txt block comes before anything the template asks the reader for.
    expect(template.indexOf('User-agent: GrantSpotter')).toBeLessThan(
      template.indexOf('Useful if you have it'),
    );
    // And it admits the limits of both remedies rather than promising a fix it cannot deliver.
    //
    // This used to assert `/once per server process/`, which was the honest description of a
    // cache that never expired: the template told a site owner their new robots.txt would be
    // ignored until the container restarted. The code was fixed on 2026-08-04 (`runCrawl` drops
    // the robots cache at the start of every run, and entries expire after six hours), so the
    // sentence to hold is the new one — a bound the reader can check against their own logs,
    // still stated as a delay rather than as an instant fix.
    expect(template).toMatch(/nightly crawl/);
    expect(template).toMatch(/within a day/);
    expect(template).not.toMatch(/will not notice your new file until it restarts/);
    expect(template).toMatch(/cannot stop somebody else's deployment/i);
  });

  /**
   * THE TEMPLATE IS NO LONGER SOMEWHERE THE CRAWLER SENDS ANYBODY.
   *
   * It was written for a reader who had followed `+https://github.com/…/issues` out of a log line,
   * and it opened "You are probably here because you saw this in a log", quoting that URL. With the
   * shared default gone, no deployment points here: the log line names the operator's own page, and
   * the only way to this file is searching the product name. That changes who is reading and what
   * they need first — so the page must not imply we can act on an instance we do not run, and must
   * say what we actually can do (take a source out of the shipped list) rather than leaving the
   * reader with an implied promise.
   */
  it('does not imply the maintainers can stop a third-party instance', () => {
    const template = readFileSync(
      resolve(REPO_ROOT, '.github/ISSUE_TEMPLATE/crawler-contact.md'),
      'utf8',
    );
    // Not the address the crawler used to carry, and not the instruction that went with it.
    expect(template).not.toContain('https://github.com/Atvriders/grantspotter/issues');
    expect(template).not.toMatch(/open an issue there to contact the maintainers/);
    // It says, before anything else, that the log line names somebody who is not us.
    const disclaimer = template.indexOf('we probably do not run the instance');
    expect(disclaimer).toBeGreaterThan(-1);
    expect(disclaimer).toBeLessThan(template.indexOf('User-agent: GrantSpotter'));
    expect(template).toMatch(/self-hosted/i);
    // …and it names the remedy it CAN deliver, so the honesty is not just a refusal.
    expect(template).toMatch(/list of sources this software ships with/i);
  });

  /**
   * FINDING H: "Expect one request per night, forever. That is the whole footprint of a blocked
   * site" was false as written. A `Disallow: /` site whose `/robots.txt` 301s twice sees three
   * requests a run, and a robots.txt that is retried (as it now is, like every other request) can
   * see four. A site owner counting requests against that sentence would conclude the block had
   * failed. The template has to state the bound it can actually keep.
   */
  it('states a footprint for a blocked site that the crawler can actually keep', () => {
    const template = readFileSync(
      resolve(REPO_ROOT, '.github/ISSUE_TEMPLATE/crawler-contact.md'),
      'utf8',
    );
    expect(template).not.toMatch(/That is the whole footprint of a blocked site\.?$/m);
    expect(template).toMatch(/one request per night/);
    // The two things that make it more than one, both named, both checkable in the reader's logs.
    expect(template).toMatch(/redirect is followed/i);
    expect(template).toMatch(/up to five/i);
    expect(template).toMatch(/retried/i);
    expect(template).toMatch(/four attempts/i);
    // And the closure: nothing else generates a request.
    expect(template).toMatch(/Nothing else\./);

    /*
     * FINDING H, SECOND ROUND (2026-08-04). Naming the two extras was not a bound. "Up to five
     * hops … plus up to four attempts" reads additively and the code multiplied: the retry loop
     * sat inside the per-hop loop, so one `/robots.txt` could cost (5 + 1) x (3 + 1) = 24 requests.
     * Measured against a loopback server that both 301s and 429s: 19 requests in 6052 ms. A site
     * owner who counted requests against the sentence above would have concluded the block failed,
     * which is the same failure this test was written for, one level up.
     *
     * So the template must now state the CEILING and state that the two budgets do not multiply —
     * and the fetcher must enforce it (`maxRequestsPerFetch`, and the tests beside it).
     */
    expect(template).toMatch(/nine/i);
    expect(template).toMatch(/cannot multiply|do not multiply|not 5 x 4/i);
  });

  it('names the verified negatives so a reader does not re-research them', () => {
    for (const thing of ['CARI', 'AMSAT', 'FlexRadio', 'Chicago FM Club', 'Icom']) {
      expect(readme).toContain(thing);
    }
  });

  it('records the disputed ARRL Club Grant cycle', () => {
    expect(readme).toMatch(/Club Grant/);
    expect(readme).toMatch(/disputed/i);
  });

  /**
   * ADDED BY THE SPEC §14 FLOW WALK (Task 22). The corpus table above measures the committed
   * fixtures; a `docker compose up` installs the seed, and the two are different sizes. Boot on a
   * clean DATA_DIR prints "Imported 143 programs (143 publishable, 0 suppressed) from 26 funders",
   * so a reader who took 150/553 as "what I will have after installing" was wrong by 7 records and
   * by the entire suppressed set. The README now says both, and this binds the second one.
   */
  it('separates the fixture measurements from what a fresh install actually imports', () => {
    expect(readme).toMatch(/fresh install/i);
    expect(readme).toMatch(/143 programmes \(143 publishable, 0 suppressed\)/);
    expect(readme).toMatch(/7 of the 143/);
  });

  /**
   * There is no sign-up form for the public — but there IS a first-run screen now, and this comment
   * used to say there wasn't.
   *
   * When it was written that was accurate and was the point: `createBootstrapState` printed a
   * one-time token to the log, `POST /api/auth/bootstrap` was the only thing that could spend it,
   * and an operator told to "read the log for the token" and nothing else was left looking at a
   * sign-in box with no account to sign in as — step 1 of the product's own flow, unreachable from
   * a browser. That gap is now closed by `routes/FirstRun.tsx`, so the README describes the screen
   * and keeps the curl as the alternative rather than the only way in.
   *
   * The assertion below is unchanged and still meaningful: no public signup is a real property of
   * this product, and the README must keep saying so, because "there is a setup screen" could
   * otherwise be misread as "anyone can make themselves an account".
   */
  it('says how to spend the bootstrap token, not just where to find it', () => {
    expect(readme).toContain('/api/auth/bootstrap');
    // `\s+` and not a space: the sentence wraps mid-phrase in the source, and a regex that
    // assumes one line would fail on a reflow that changed nothing a reader can see.
    expect(readme).toMatch(/no\s+sign-?up\s+form/i);
    // The screen exists; a README that still called it API-only would be the product's front page
    // contradicting the product.
    expect(readme).toMatch(/first-run screen/i);
  });

  /**
   * The Deploying section used to open with `cp .env.example .env`. That file is gone — the owner
   * asked for one file to edit — so the instruction is now a pointer to nothing, and a README that
   * still printed it would strand a reader on step one. The replacement design has a sharp edge
   * that has to be documented rather than discovered: the compose file ships working-looking
   * literals, and the server refuses BOTH of them by value.
   *
   * (It said two, then one for the day CONTACT_URL had a default, and it is two again.
   * `compose.test.ts` holds the sharper version of the same claim — each edit made in turn, with
   * the loader still required to refuse until both are.)
   */
  it('does not send the reader to a file this repository no longer ships', () => {
    expect(readme).not.toContain('.env.example');
    expect(readme).not.toMatch(/cp \.env/);
  });

  it('says the shipped values are placeholders and that the server rejects them', () => {
    expect(readme).toContain('docker-compose.yml');
    expect(readme).toContain(PLACEHOLDER_MARKER); // the marker, imported, not a retyped copy
    expect(readme).toMatch(/refuses? to start|refuses the shipped/i);
    expect(readme).toContain('openssl rand -hex 32');
    // Two edits, said as a number where the reader is deciding how much work this is.
    expect(readme).toMatch(/\*\*two\*\* values marked/i);
    expect(readme).toMatch(/while either is\s+still there/i);
  });

  it('gives the deploy path including the workflow_dispatch gotcha', () => {
    expect(readme).toContain('ghcr.io/atvriders/grantspotter');
    expect(readme).toContain('HOST_PORT');
    expect(readme).toContain('3030');
    expect(readme).toContain('workflow_dispatch');
  });

  it('contains no real LAN address, hostname or host path', () => {
    expect(readme).not.toMatch(/\b(?:192\.168|10)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    expect(readme).not.toMatch(/\/home\/[a-z0-9_-]+\//i);
    expect(readme).not.toMatch(/\/mnt\/user\//);
  });

  it('documents only npm scripts that exist', () => {
    const documented = [...readme.matchAll(/npm run ([a-z0-9:_-]+)/g)].map((m) => m[1]!);
    expect(documented.length).toBeGreaterThan(0);
    for (const script of new Set(documented)) {
      expect(Object.keys(rootPkg.scripts), `npm run ${script}`).toContain(script);
    }
  });
});
