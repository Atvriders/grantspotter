import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { firstRunBanner } from '../auth/bootstrap.js';
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

/**
 * ONE SECTION OF THE README, SO A GATE CAN SAY "NOT ANYWHERE IN HERE".
 *
 * WHY THIS EXISTS AT ALL. On 2026-08-11 the callsign lookup was removed from the first-run setup
 * screen, and two sentences saying it was still there survived a 425-line rewrite of this file **in
 * the same commit** — `There is a button beside the callsign field on the profile screen and on the
 * first-run setup screen`, and `Who may press it. You, for your own profile, or the operator during
 * first-run setup.` Every gate in this file was green throughout, because each one asserts that
 * something IS present. A `toContain` cannot see a sentence that should have gone, and a rewrite is
 * exactly the operation that leaves those behind: the paragraphs around them changed, so they read
 * as freshly written.
 *
 * So the gates below are the other kind. They take a section and require that a retired thing is
 * absent from all of it, with the source file that retired it read in the same test — an absence
 * assertion that is bound to the code cannot become a stale prohibition, because the day the code
 * brings the feature back the gate stops demanding its absence.
 */
function readmeSection(heading: string): string {
  const start = readme.indexOf(`\n${heading}\n`);
  expect(start, `README has no section headed ${heading}`).toBeGreaterThan(-1);
  const after = start + heading.length + 2;
  const nextHeading = /^## /m.exec(readme.slice(after));
  return readme.slice(after, nextHeading === null ? undefined : after + nextHeading.index);
}

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
    /**
     * `ENROLLMENT_CODE`, `ENROLLMENT_CODE_MAX_USES` and `ENROLLMENT_CODE_DAYS` WERE IN THAT LIST
     * AND ARE NOT ANY MORE, BECAUSE THEY ARE NOT VARIABLES ANY MORE (2026-08-11). The README still
     * names all three — an operator upgrading has them in their file and needs to be told they are
     * ignored — so this asserts the opposite of what it used to: they must appear as a retirement
     * and must NOT appear as a row in the table of variables this build reads.
     */
    for (const gone of ['ENROLLMENT_CODE', 'ENROLLMENT_CODE_MAX_USES', 'ENROLLMENT_CODE_DAYS']) {
      expect(readme, `${gone} is documented as a live variable again`).not.toMatch(
        new RegExp(`^\\| \`${gone}\` \\|`, 'm'),
      );
    }
    expect(readme).toMatch(/no longer exists/i);
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
    //
    // This asserted `/at most nine requests/` until 2026-08-04. The sentence it was holding —
    // "nine requests to your server" — was measured false the same day for a machine answering to
    // two names (18, `npm run measure-pacing twoNamesOneMachine`), so the assertion moves with the
    // claim and is strictly harder: the README must now say the ceiling counts EVERY request the
    // fetch makes, not merely the ones aimed at one server.
    expect(readme).toMatch(/at most nine HTTP requests in total/i);
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
   * THE ASSERTION THAT USED TO BE HERE WAS NOT WRONG, TWICE OVER. THE PRODUCT CHANGED UNDER IT
   * TWICE.
   *
   * It first required the README to say `no sign-up form`, which described a deliberate design for
   * the life of this project: a one-time token, `POST /api/auth/bootstrap` as the only thing that
   * could spend it, and every later account made by an administrator. Enrollment codes made that
   * false and the sentence was replaced with a narrower one. Open sign-up (2026-08-11) has now made
   * the replacement false too, and the codes are gone; the block near the bottom of this file holds
   * what is true instead.
   *
   * What this test keeps is the part neither change touched: the bootstrap token has a documented
   * way to SPEND it, not merely a place to find it, and the first administrator comes from that
   * token and can come from nowhere else. That claim matters more after the change than before it,
   * because it is now the only thing standing between an unattended fresh container and whoever
   * reaches it first.
   *
   * `comes from the log` became `comes from that token` on the same day, and for a different
   * reason: `bootstrap.ts` stopped printing the token and started writing it to a 0600 file, so a
   * gate demanding the phrase would have kept the README pointing at a log the token is not in.
   */
  it('says how to spend the bootstrap token, not just where to find it', () => {
    expect(readme).toContain('/api/auth/bootstrap');
    // The screen exists; a README that still called it API-only would be the product's front page
    // contradicting the product.
    expect(readme).toMatch(/first-run screen/i);
    // `\s+` and not a space throughout: these sentences wrap mid-phrase in the source, and a regex
    // that assumes one line would fail on a reflow that changed nothing a reader can see.
    expect(readme).toMatch(/first\s+administrator\s+always\s*\n?\s*comes\s+from\s+that\s+token/i);
    // …and why it cannot be otherwise, which is the sentence that stops open sign-up being mistaken
    // for a way to stand an instance up.
    expect(readme).toMatch(/cannot\s+bootstrap\s+an\s+instance/i);
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

/**
 * THE ONE REQUEST THIS PRODUCT MAKES THAT A `robots.txt` DOES NOT STOP.
 *
 * The README's central promise to a polled site is that `User-agent: GrantSpotter` /
 * `Disallow: /` is the remedy that works no matter who is running what. On 2026-08-04 that
 * sentence became false as written: the callsign lookup queries `callook.info`, which publishes
 * `Disallow: /`.
 *
 * The fix is NOT to weaken the crawler, and it is not to delete the sentence either. It is to say
 * both true things and the tension between them — the crawler obeys robots.txt absolutely and
 * everywhere; the lookup is one user-initiated request, to one host, about the caller's own public
 * licence record, which RFC 9309 does not scope; and callook's own API reference grants that use
 * in writing. A README that states only the convenient half is the failure mode this project
 * exists to avoid, so the inconvenient half is what these gates hold.
 */
describe('README: the callsign lookup, described against itself', () => {
  it('names the section and reaches it from the polite-crawling promise', () => {
    expect(readme).toMatch(/^## The callsign lookup$/m);
    // The anchor the crawler sections point at. A dangling in-page link is how a caveat gets lost.
    expect(readme).toMatch(/\(#the-callsign-lookup\)/);
  });

  it('states BOTH of the site owner’s documents, including the one against us', () => {
    // The refusal, quoted rather than summarised, with the date it was read.
    expect(readme).toMatch(/callook\.info\/robots\.txt/);
    expect(readme).toMatch(/`User-agent: \*` \/ `Disallow: \/`/);
    expect(readme).toMatch(/2026-08-04/);
    // The permission, quoted, and named as the same owner's.
    expect(readme).toMatch(/free to use however you wish/);
    // And the reasoning, not just the conclusion.
    expect(readme).toMatch(/RFC 9309/);
    expect(readme).toMatch(/automatic clients known as crawlers/);
  });

  it('does not let the exception read as a softening of the crawler', () => {
    expect(readme).toMatch(
      /nightly crawler is a different thing and obeys `robots\.txt` absolutely, everywhere/,
    );
    expect(readme).toMatch(/not a hole in that and is not a precedent for one/i);
  });

  it('gives the operator a switch, on by default, and says where it lives', () => {
    expect(readme).toMatch(/CALLSIGN_LOOKUP_ENABLED/);
    expect(readme).toMatch(/CALLSIGN_LOOKUP_ENABLED=false/);
    expect(readme).toMatch(/defaults to \*\*on\*\*|defaults to `true`/i);
    expect(readme).toMatch(/`CALLSIGN_LOOKUP_ENABLED` \| no \| `true`/);
  });

  /**
   * THE LIST OF FILLED FIELDS, CHECKED AGAINST THE CODE THAT FILLS THEM.
   *
   * This paragraph first said "Name, operator class, city, state, ZIP, and — for a club licence —
   * the organisation name", which was wrong in three places at once: a person's name, the city and
   * the ZIP are DISPLAYED and then dropped, because the profile has no field for any of them.
   * Overstating what a lookup writes into somebody's profile is precisely the misattribution this
   * whole feature is careful about everywhere else, so the sentence is bound to the one function
   * that decides it — `acceptedValues` in `packages/web/src/lib/callsignFill.ts`, whose own comment
   * says it is written out longhand "so a new accepted field is a deliberate line here". A fifth
   * line there now fails this test until the README grows a fifth value.
   */
  it('names exactly the fields the lookup actually fills, by the label they carry', () => {
    const fill = readFileSync(resolve(REPO_ROOT, 'packages/web/src/lib/callsignFill.ts'), 'utf8');
    const written = [...fill.matchAll(/\['([a-zA-Z]+)', accepted\./g)].map((m) => m[1]!);
    expect(written.length, 'the accepted-values parser found nothing').toBeGreaterThan(0);

    // Profile field key → the form label the README promises the reader they will see.
    //
    // `lat` AND `lon` ARRIVED ON 2026-08-11, AND THE COUNT IN THE README MOVED WITH THEM. This is
    // the fifth and sixth line in `acceptedValues`, which is exactly what the note above predicts
    // ("a fifth line there now fails this test until the README grows a fifth value") — the
    // callsign lookup had been receiving a latitude, a longitude and a grid square on every
    // successful call and discarding all three, and it now offers the pair the profile has fields
    // for. The prose obligations below are part of the same claim: a coordinate is filled from a
    // street address and NOT from a PO box, and it is the one filled value the profile cannot mark.
    const documented: Record<string, string> = {
      callsign: 'Callsign',
      state: 'State',
      licenseClass: 'License class',
      orgName: 'Organization name',
      lat: 'Latitude',
      lon: 'Longitude',
    };
    expect(new Set(written)).toEqual(new Set(Object.keys(documented)));

    expect(readme).toMatch(/six values, and only six/i);
    for (const label of Object.values(documented)) {
      expect(readme, label).toContain(`**${label}**`);
    }
    // …and it says, in the same breath, why the rest of the record is not on that list.
    expect(readme).toMatch(/no street field, no\s*\n?\s*city field, no ZIP field/i);
  });

  /**
   * THE COORDINATE'S TWO CAVEATS, WHICH ARE THE WHOLE REASON IT IS SAFE TO FILL ONE IN.
   *
   * A latitude is the only value this lookup writes that means something other than what it looks
   * like. callook geocodes the MAILING address, so for the PO box a collegiate club typically
   * files it is a post office — and `matcher` reads latitude and longitude for radius eligibility
   * and nothing else, so a mail-drop coordinate accepted silently produces a confident verdict
   * about somebody's post office. The README has to carry both halves: the rule the software
   * follows, and the fact that a saved coordinate can no longer say where it came from.
   */
  it('says a coordinate is a mail drop, and that the profile cannot mark one', () => {
    expect(readme).toMatch(/PO box/);
    expect(readme).toMatch(/the coordinate\s*\n?\s*is a post office/i);
    // The rule, not merely the risk: filled from a street address, offered for a box.
    expect(readme).toMatch(/only from a \*\*street address\*\*/i);
    expect(readme).toMatch(/waits for a second press/i);
    // The half that outlives the lookup.
    expect(readme).toMatch(/nowhere to record that about a number/i);
    expect(readme).toMatch(/reads exactly like one you typed/i);
    // And what an empty box actually costs, which is the question it raises.
    expect(readme).toMatch(/\*\*unanswered\*\* rather than answered against you/i);
  });

  /**
   * The third case beside "the source said it" and "you said it": a value this tool worked out
   * from another field. Crediting callook.info for the digit in a callsign would credit a source
   * for arithmetic — core refuses it in `StudentFieldSources` — so the README must not list the
   * call district among the values the lookup FILLS while still telling the reader it appears.
   */
  it('explains the call district as arithmetic rather than as something read', () => {
    expect(readme).toMatch(/\*\*Call district\*\*/);
    expect(readme).toMatch(/digit in your callsign, worked out here rather than read anywhere/i);
    expect(readme).toMatch(/follows the callsign box/i);
  });

  it('says what it fills, what it refuses to fill, and what it does with the address', () => {
    // The refusal is the interesting half: grantDate is not "first licensed".
    expect(readme).toMatch(/licensedSince/);
    expect(readme).toMatch(/grantDate/);
    expect(readme).toMatch(/resets on every renewal/i);
    // The legacy classes it will not guess upward from.
    expect(readme).toMatch(/Novice, Advanced, Technician Plus/);
    expect(readme).toMatch(/guessing upward/i);
    // The address: shown to confirm identity, not kept.
    expect(readme).toMatch(/\*\*not stored\*\*/);
    // And the mandatory attribution, both parties named.
    expect(readme).toMatch(/Federal Communications Commission/);
    expect(readme).toMatch(/public-domain US Government work/);
  });

  it('blocklists the three directories that are the obvious second source', () => {
    for (const host of ['qrz.com', 'hamcall.net', 'buckmasterinternational.com']) {
      expect(readme, host).toContain(host);
    }
    expect(readme).toMatch(/forbid automated access/i);
    // The reason they are listed rather than merely not used.
    expect(readme).toMatch(/second source/i);
  });

  /**
   * THE BUTTON IS DESCRIBED AS BEING WHERE IT IS, CHECKED AGAINST THE SCREENS THEMSELVES.
   *
   * `Profile.tsx` renders `<CallsignLookup`; `FirstRun.tsx` did too until 2026-08-11 and does not
   * any more — account creation stopped asking for a callsign. The README went on saying the button
   * was on both screens, in the section a reader goes to precisely because they cannot find it.
   *
   * Read from the sources rather than hard-coded, so this is a statement about the product and not
   * a second copy of it: if the panel ever returns to the setup screen the requirement inverts by
   * itself, and the README is required to say so again.
   */
  it('puts the button on the screens that actually render it, and on no others', () => {
    const screen = (file: string): string =>
      readFileSync(resolve(REPO_ROOT, 'packages/web/src/routes', file), 'utf8')
        // Comments only. Both files carry long notes ABOUT the panel, and `FirstRun.tsx`'s note is
        // the record of its removal — a scanner cannot tell that from a render.
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
        .replace(/^\s*\/\/.*$/gm, '');
    const section = readmeSection('## The callsign lookup');

    expect(screen('Profile.tsx'), 'the profile screen no longer renders the panel').toMatch(
      /<CallsignLookup/,
    );
    expect(section).toMatch(/button beside the callsign field on the profile screen/i);

    if (!/<CallsignLookup/.test(screen('FirstRun.tsx'))) {
      expect(
        section,
        'the setup screen does not render the lookup panel, and this section says it does',
      ).not.toMatch(/on the first-run setup\s*\n?\s*screen/i);
      expect(
        section,
        'this section still names the operator during setup as somebody who may press it',
      ).not.toMatch(/the operator during first-run setup/i);
    }
  });

  /**
   * AND IT IS DESCRIBED AS NEEDING THE CREDENTIAL IT ACTUALLY NEEDS.
   *
   * The route accepted the one-time setup token from an unauthenticated caller for as long as the
   * setup screen had the panel. `api/callsign.ts` retired it on 2026-08-11; the prose has to retire
   * with it, and — the half that matters — must not be able to come back on its own. Bound to the
   * route file, so the day a `setupToken` is declared there again this stops forbidding it.
   */
  it('does not offer a reader a credential the route no longer accepts', () => {
    const route = readFileSync(resolve(REPO_ROOT, 'packages/server/src/api/callsign.ts'), 'utf8');
    const schema = /const lookupBodySchema = z[\s\S]*?\.strict\(\);/.exec(route)?.[0];
    expect(schema, 'the body schema is no longer in a shape this test can read').toBeTruthy();

    if (!/setupToken/.test(schema ?? '')) {
      const section = readmeSection('## The callsign lookup');
      // The README may say the privilege WAS there and went — that record is worth keeping — but it
      // must not tell anybody how to use it, so the prohibition is on the instruction, not the word.
      expect(section).not.toMatch(/send the (one-time )?setup token/i);
      expect(section).toMatch(/no unauthenticated way to reach it/i);
    }
  });

  it('tells a site owner about it in the template they actually read', () => {
    const template = readFileSync(
      resolve(REPO_ROOT, '.github/ISSUE_TEMPLATE/crawler-contact.md'),
      'utf8',
    );
    expect(template).toMatch(/callook\.info/);
    expect(template).toMatch(/free to use however you wish/);
    expect(template).toMatch(/RFC 9309/);
    // The reader's own question answered first: is this what is in MY log?
    expect(template).toMatch(/unless you run `callook\.info`/i);
    // And the remedy that is actually ours to give, offered to the one site it applies to.
    expect(template).toMatch(/If you are callook\.info/);
  });
});

/**
 * THE PUBLISHED CEILING, AFTER THE THIRD ROUND OF MEASURING IT.
 *
 * `states the pacing rules a polled site can check against its own logs` above holds the number.
 * This holds what the number COUNTS, which is what has been wrong every time. The README said "one
 * page fetch, or one `/robots.txt` read, costs at most nine requests" and that `or` licensed 9 + 9,
 * plus a fresh nine per origin — sixty-three, measured. It then said "nine to your server", and a
 * server answering to an apex AND a `www` was measured at eighteen. The claim that survives is the
 * one with no "to whom" in it at all, and these gates hold that.
 */
describe('README: nine means nine, wherever the chain goes', () => {
  it('counts the robots.txt read inside the ceiling, not beside it', () => {
    expect(readme).toMatch(/at most nine HTTP requests in total/);
    expect(readme).toMatch(/`\/robots\.txt` read included/);
    // The `or` that licensed the doubling must not come back.
    expect(readme).not.toMatch(/One page fetch, or one `\/robots\.txt` read, costs/);
    // Nor may the scoped version, which is the sentence that was measured false on 2026-08-04.
    expect(readme).not.toMatch(/at most nine requests to your server/);
    // The measured before-figures stay, because a reader deciding whether to trust the number is
    // owed the history — but see the test below for the condition attached to printing them.
    expect(readme).toMatch(/18, 20, 63 and 18/);
  });

  /**
   * THE ASSERTION THIS REPLACES IS THE ONE THE ROUND WAS ABOUT, AND IT IS NOW INVERTED.
   *
   * It required the README to say a redirect to a *different host* gets that host its own nine, on
   * the reasoning that a different host is a different owner entitled to a full allowance. That
   * reasoning could not survive the measurement: a URL does not say who owns it, `example.org` and
   * `www.example.org` are different hosts by that test and one machine in practice, and the
   * entitlement was worth 18 requests to one kernel. The purse is now per fetch and has no key, so
   * the README must NOT make the old promise, and must state the cost of the new rule rather than
   * only its benefit.
   */
  it('does not promise a fresh allowance to whatever it is redirected to', () => {
    expect(readme).not.toMatch(/still gets that host its own nine/i);
    expect(readme).toMatch(/one fetch, nine requests, wherever they land/i);
    // The cost, said in the README rather than discovered by an operator wondering why a source
    // was skipped.
    expect(readme).toMatch(/can cost \*us\* a source for a\s*\n?\s*night/i);
  });

  /**
   * "REAL NUMBERS OFF REAL SOCKETS, AND YOU CAN REPRODUCE THEM" WAS FALSE FOR ONE OF THEM.
   *
   * Both documents published a figure for an `http://` -> `https://` redirect and said the harness
   * in this repository would reproduce it. `scripts/measure-pacing.ts` could not serve https at all:
   * that number came from a scratchpad script with a self-signed certificate that was never
   * committed. The harness generates its own certificate now — so the gate is that the claim and the
   * capability travel together, in BOTH directions: every scenario named in either document must
   * exist in the harness, and the figures that genuinely cannot be reproduced must be labelled.
   */
  it('names only scenarios the shipped harness actually has', () => {
    const harness = readFileSync(resolve(REPO_ROOT, 'scripts/measure-pacing.ts'), 'utf8');
    const block = /const SCENARIOS: Record<string, \(\) => Promise<void>> = \{([\s\S]*?)\n\};/.exec(
      harness,
    );
    expect(block, 'could not find the SCENARIOS map in scripts/measure-pacing.ts').not.toBeNull();
    const shipped = new Set(
      [...(block?.[1] ?? '').matchAll(/^\s{2}([A-Za-z0-9]+)[,:]/gm)].map((m) => m[1] as string),
    );
    expect(shipped.size).toBeGreaterThan(10);

    const template = readFileSync(
      resolve(REPO_ROOT, '.github/ISSUE_TEMPLATE/crawler-contact.md'),
      'utf8',
    );
    const named = [...`${readme}\n${template}`.matchAll(/measure-pacing ([A-Za-z0-9]+)/g)].map(
      (m) => m[1] as string,
    );
    expect(named.length).toBeGreaterThan(5);
    for (const scenario of new Set(named)) {
      expect([...shipped], `npm run measure-pacing ${scenario}`).toContain(scenario);
    }
    // The scenario that carries the reproducibility claim for the https figure has to be one of
    // them, and it has to be the one that actually speaks TLS.
    expect(shipped).toContain('schemeChange');
    expect(harness).toMatch(/createServer as createTlsServer/);
  });

  it('labels the figures that cannot be reproduced from this tree, instead of implying they can', () => {
    const template = readFileSync(
      resolve(REPO_ROOT, '.github/ISSUE_TEMPLATE/crawler-contact.md'),
      'utf8',
    );
    for (const doc of [readme, template]) {
      // `\s+` and not a space: both sentences wrap mid-phrase in their source, and a regex that
      // assumed one line would fail on a reflow that changed nothing a reader can see.
      expect(doc).toMatch(/cannot be\s+(reproduced|re-measured)\s+from\s+(this|the current)/i);
      // The commits they WERE measured at, so "not reproducible" is a fact with an address rather
      // than an excuse.
      expect(doc).toContain('2c098d9');
      expect(doc).toContain('8ec9873');
      // And the provenance of the one that was published as reproducible while it was not.
      expect(doc).toMatch(/never committed/i);
    }
    // …and the claim that was false must not come back in the form that made it false.
    expect(template).not.toMatch(
      /Those are real numbers off real sockets, and you can reproduce them — `npm run measure-pacing`\s*\n\s*in this repository/,
    );
  });

  /**
   * The one number in this section that is not a fix. `www.arrl.org` is polled under two origins
   * because two of the eight shipped ARRL source URLs are spelled `http://`, so a `Disallow: /`
   * there costs two requests a night and not one. The fetcher is RIGHT to read both — rules are
   * per origin, and reusing one origin's file for another is exactly the "value we derived
   * presented as a value somebody stated" this product refuses. So the README states the true
   * number instead of the flattering one.
   */
  it('states the true per-origin cost for a site that blocks us', () => {
    expect(readme).toMatch(/one request per\s*\n?\s*origin we poll it under, per run/);
    expect(readme).toMatch(/www\.arrl\.org/);
    expect(readme).toMatch(/measure-pacing twoOriginsOneHost/);
    expect(readme).toMatch(/rules nobody gave us/i);
  });
});

/**
 * ENROLMENT IS A THIRD DOOR, AND THE README HAS TO KEEP SAYING IT IS A DOOR WITH A LOCK ON IT.
 *
 * These gates replace `expect(readme).toMatch(/no\s+sign-?up\s+form/i)`, which is documented at its
 * old site above. Two opposite failures are now possible and this block has to fail on both.
 *
 * The first is the one the retired assertion was written for: a README that still says there is no
 * sign-up form while the product ships one. That is a front page contradicting the screen the
 * reader is looking at, and it is how somebody later "restores" the old behaviour on the grounds
 * that the docs say it is supposed to work that way.
 *
 * The second is the overcorrection, and it is the more expensive one: "GrantSpotter now has
 * sign-up". An operator who reads that puts an instance on the open internet believing
 * registration is a feature they enabled and can disable, when what actually gates it is a secret
 * they issue, limit and revoke. Blurring those two is how an instance ends up with accounts nobody
 * meant to allow.
 *
 * So the negative gates name the sentences, in both directions, and the positive ones name the
 * mechanism — an issuer, a limit, an expiry, a revocation, a hash, a rate limit, a transaction —
 * because "we take security seriously" is satisfiable by wording and none of these are.
 */
/**
 * SIGN-UP IS OPEN, AND EVERY ASSERTION IN THIS BLOCK IS THE REVERSE OF THE ONE IT REPLACES.
 *
 * WHAT WAS HERE, AND WHY IT IS NOT BEING RELAXED. This block was called "enrolment is a third door,
 * not an open one" and it required the README to say `no open sign-up`, to say `three things can
 * bring an account into existence` and `not one of them is open registration`, and to REFUSE the
 * sentences `anyone can create`, `sign-up is now open` and `open to the public` by name. Every one
 * of those was accurate about the design of the day and every one of them is now FALSE of the
 * product: the owner asked for open account creation, so anybody who can reach a deployment makes
 * their own member account. A gate that still demanded `no open sign-up` would be requiring the
 * README to lie — which is the exact failure the block's own comments record twice, once for a
 * corpus statistic and once for the enrolment budget.
 *
 * SO THE REFUSALS ARE INVERTED RATHER THAN DELETED, and they are the same instrument pointed the
 * other way: a README that quietly grows the retired claims back — a code, an administrator issuing
 * one, a screen to revoke them on — fails by name. That matters more than usual here, because the
 * old sentences were good sentences and a future editor reaching for "there is no open sign-up" is
 * reaching for something this README said for the whole life of the project.
 *
 * WHAT IS KEPT UNCHANGED, because retirement did not touch it: the first-run token is still the
 * only way to the first administrator and still cannot be replaced by signing up; the role is still
 * not a parameter of the request; the password floor is still one policy; and the honest limits of
 * what the product promises about an email address are still stated rather than rounded off.
 */
describe('README: sign-up is open, and says what that does and does not give away', () => {
  it('no longer claims an administrator has to act before an account can exist', () => {
    // The retired claims, refused by name. Each was asserted as REQUIRED by this file until
    // 2026-08-11; the product changed under them.
    expect(readme).not.toMatch(/no\s+open\s+sign-?up/i);
    expect(readme).not.toMatch(/no\s+public\s+sign-?up/i);
    expect(readme).not.toMatch(/no\s+sign-?up\s+form/i);
    expect(readme).not.toMatch(/not\s+one\s+of\s+them\s+is\s+open\s+registration/i);
    expect(readme).not.toMatch(/code\s+(that\s+)?an\s+administrator\s+issued/i);
    expect(readme).not.toMatch(/cannot\s+(create|make)\s+(their|your)\s+own\s+account/i);
    // And the capability that replaced them, in the words that mean it.
    expect(readme).toMatch(/anybody\s+who\s*\n?\s*can\s+reach\s+this\s+deployment\s+can\s+create\s+a\s+member\s+account/i);
    expect(readme).toMatch(/^### Signing up$/m);
    expect(readme).toContain('(#signing-up)');
  });

  /**
   * The feature went; the record of it must not. A reader who finds `enrollment_codes` in their
   * database, or the three variables in their compose file, has to be able to find out here what
   * they were and what happened to them — and an operator upgrading has to be told that the rows
   * and the stale variables are both harmless.
   */
  it('keeps the record of what enrolment codes were and why they went', () => {
    expect(readme).toMatch(/enrollment code/i);
    expect(readme).toMatch(/cost more than it bought/i);
    // The three retired variables are named as retired, so somebody grepping their own file finds
    // the answer here rather than concluding the README is out of date.
    for (const gone of ['ENROLLMENT_CODE', 'ENROLLMENT_CODE_MAX_USES', 'ENROLLMENT_CODE_DAYS']) {
      expect(readme, gone).toContain(gone);
    }
    expect(readme).toMatch(/starts fine/i);
    // The database decision, pointed at the file that argues it, because "why is this table still
    // here" is the first question an operator with a `sqlite3` shell will have.
    expect(readme).toMatch(/closed record/i);
    expect(readme).toContain('095-enrollment-codes-are-a-closed-record.sql');
  });

  it('keeps the first-run token as the only way to the first administrator', () => {
    expect(readme).toMatch(/first\s+administrator\s+always\s*\n?\s*comes\s+from\s+that\s+token/i);
    // The property that stops open sign-up from being a way to claim an unattended container. It
    // is the one security claim the retirement had to keep, and it is now the ONLY thing standing
    // between a fresh public deployment and whoever finds it first.
    expect(readme).toMatch(/cannot\s+bootstrap\s+an\s+instance/i);
    expect(readme).toMatch(/nothing\s+here\s+creates\s+an\s+account\s+at\s+all/i);
  });

  /**
   * THE TOKEN MOVED OUT OF THE LOG (2026-08-11) AND THE README HAD TO MOVE WITH IT. `bootstrap.ts`
   * now writes it to a 0600 file in `DATA_DIR` and prints only the path, because `docker logs`
   * keeps a line for the life of the container. A README still telling an operator to read the
   * token out of the log would strand them at step one of a first install — the worst place a doc
   * can be wrong.
   */
  it('sends the operator to the token file, not to the log', () => {
    expect(readme).toMatch(/not\s+in\s+`docker compose logs`/i);
    expect(readme).toContain('first-run-token.txt');
    expect(readme).toMatch(/deleted the moment it is spent/i);
    // The fallback is a real branch of `bootstrap.ts` and an operator who meets it needs to have
    // been told it exists, because the remedy is theirs (fix the volume) and the cost is a secret
    // in a log that does not forget.
    expect(readme).toMatch(/could not be written/i);
  });

  it('says enrolment produces a member and that the request cannot ask for more', () => {
    expect(readme).toMatch(/role\s+is\s+not\s+a\s+parameter\s+of\s+the\s+request/i);
    expect(readme).toMatch(/passes\s+the\s+literal\s+`member`/i);
    expect(readme).toMatch(/only\s+way\s+to\s+a\s+second\s+administrator/i);
    // The password floor is one policy in this codebase, and the README must not read as if
    // signing up brought its own.
    expect(readme).toMatch(/same\s+12-character\s+floor/i);
  });

  /**
   * THE BUDGET CHANGED SUBJECT, WHICH IS A HARDER CHANGE THAN CHANGING ITS NUMBERS.
   *
   * These three ceilings used to be charged only on the branch that answered "that enrollment code
   * is not valid". A person holding a real code never read them, which is what made it safe for the
   * lower two rungs to be as coarse as they are, and the README said so. There is no wrong code any
   * more, so the same counters now sit on the path of EVERY legitimate registration — and a README
   * that repeated the old reassurance would be promising something the shipped route cannot keep.
   *
   * So the numbers are still read out of `api/auth.ts` rather than transcribed, for the reason this
   * file has recorded twice: a doc gate should pin the honesty and, where it must pin a number,
   * read that number out of the source. What changed is the sentence they are required to appear
   * in, and the reassurance that is now refused by name.
   */
  it('states what actually bounds registration, in numbers read out of the route', () => {
    const route = readFileSync(resolve(REPO_ROOT, 'packages/server/src/api/auth.ts'), 'utf8');
    const perConnection = /REGISTRATION_MAX_PER_CONNECTION = (\d+)/.exec(route)?.[1];
    const perNetwork = /REGISTRATION_MAX_PER_NETWORK = (\d+)/.exec(route)?.[1];
    const perServer = /REGISTRATION_MAX_DEPLOYMENT = (\d+)/.exec(route)?.[1];
    const windowMin = /REGISTRATION_WINDOW_MS = (\d+) \* 60 \* 1000/.exec(route)?.[1];
    for (const [name, value] of Object.entries({
      REGISTRATION_MAX_PER_CONNECTION: perConnection,
      REGISTRATION_MAX_PER_NETWORK: perNetwork,
      REGISTRATION_MAX_DEPLOYMENT: perServer,
      REGISTRATION_WINDOW_MS: windowMin,
    })) {
      expect(value, `${name} is no longer a literal in the shape this test reads`).toBeTruthy();
    }
    // `\s+` between every word: these sentences wrap mid-phrase at the file's 100-column margin,
    // and a gate that failed on a reflow would be a tax on editing prose rather than a guard on it.
    expect(readme).toMatch(new RegExp(`\\b${String(perConnection)}\\s+sign-ups\\s+per\\s+connection\\b`));
    expect(readme).toMatch(new RegExp(`\\b${String(perNetwork)}\\s+per\\s+source\\s+network\\b`));
    expect(readme).toMatch(new RegExp(`\\b${String(perServer)}\\s+across\\s+the\\s+whole\\s+server\\b`));
    expect(readme).toMatch(new RegExp(`\\b${String(windowMin)}-minute\\b`));
    /*
     * INVERTED ON 2026-08-11, AND THE ASSERTION IT REPLACES IS NAMED RATHER THAN QUIETLY DROPPED.
     *
     * This line used to require `Every attempt is counted, not every failure`. That was a true
     * description of the route as it then stood — the counters were charged on the address, before
     * the hash, whatever happened afterwards. The route now CLAIMS a slot before the hash and
     * RECORDS it only after `users.create` returns, so a refusal, a taken address, a shed request
     * and a lost race all release their slot and leave no mark (see `REGISTRATION_WINDOW_MS` in
     * `api/auth.ts`, "WHAT IS COUNTED IS AN ACCOUNT THAT EXISTS, AND NOTHING ELSE"). A README still
     * saying "every attempt" would overstate the budget by the whole width of the probe traffic.
     *
     * So the old sentence is now FORBIDDEN, in the same shape the wrong-codes reassurance below is
     * forbidden, and the sentence that is true is required beside it. Requiring the new one alone
     * would let both stand in the file at once.
     */
    expect(readme).toMatch(/Every\s+account\s+created\s+is\s+counted,\s+not\s+every\s+attempt/i);
    expect(
      /\*\*Every\s+attempt\s+is\s+counted,\s+not\s+every\s+failure\*\*/i.test(readme),
      'The README is asserting again that every registration ATTEMPT is charged to the budget. ' +
        'It is not: a slot is claimed before the hash and recorded only once the account row ' +
        'exists, so everything that fails releases it. Quoting the retired sentence as history is ' +
        'fine — it appears unbolded a paragraph later — but it must not be the claim.',
    ).toBe(false);
    expect(readme).toMatch(/closing\s+that\s+one\s+takes\s+at\s+least\s+two\s+networks\s+acting\s+together/i);
    /*
     * BOTH DAILY FIGURES, BECAUSE ONE OF THEM IS THE OLD NUMBER. `23,040 a day` was the whole
     * deployment's ceiling when the server-wide rung was 240; at 480 it is what the network rung
     * allows, which is what an operator behind a tunnel actually faces. Asserting only `23,040`
     * would therefore have gone on passing against a README that had never been updated — the
     * precise failure mode this file exists to prevent — so the deployment-wide figure is required
     * too, and the tunnel figure is required to say that is what it is.
     */
    expect(readme).toMatch(/46,080 a day/);
    expect(readme).toMatch(/23,040 a day behind the tunnel/i);
    // The change of subject, said rather than left for a reader to infer from the absence of the
    // old promise.
    expect(readme).toMatch(/on\s+the\s+path\s+of\s+every\s+legitimate\s+registration/i);
    // The retired reassurance, refused by name. It was true and is not.
    expect(
      /nothing a stranger does with wrong\s+codes can stop your students enrolling/i.test(readme),
      'The README is back to promising that a stranger cannot spend the registration budget on ' +
        'behalf of a legitimate user. That was true only because the counters were charged on the ' +
        'wrong-code branch, and there is no wrong-code branch — every sign-up charges them now.',
    ).toBe(false);
    // What no number can buy, which is the honest half and the reason the ceiling is not sold as a
    // defence.
    expect(readme).toMatch(/mass\s+registration\s+and\s+denial\s+of\s+registration\s+are\s+the\s+same\s+act/i);
    expect(readme).toMatch(/bounded,\s+loud\s+and\s+\*?\*?\s*reversible/i);
    expect(readme).toMatch(/authenticating proxy/i);
  });

  it('does not oversell what an open instance keeps private', () => {
    // The two disclosures, stated rather than discovered.
    expect(readme).toMatch(/no email verification/i);
    expect(readme).toMatch(/already\s+has\s+an\s+account\s+is\s+told\s+so/i);
    expect(readme).toMatch(/not\s+a\s+leak\s+worth\s+pretending\s+about/i);
    // And the remedy for an operator who actually needs the door shut, which this software cannot
    // be. A README that implied a setting existed would send somebody looking for one.
    expect(readme).toMatch(/VPN,\s+an\s+SSO\s+proxy,\s+an\s+IP\s+allow-list/i);
    // Atomicity, as a claim a reader can check, with the defect it guards against named — this
    // project shipped exactly this bug in the callsign lookup.
    expect(readme).toMatch(/at\s+the\s+same\s+instant\s+get\s+one\s+account,\s+not\s+two/i);
    expect(readme).toMatch(/eight\s+simultaneous\s+presses\s+produced\s+eight\s+requests/i);
    expect(readme).toMatch(/checked\s+before\s+an\s+`await`\s+and\s+written\s+after\s+it\s+is\s+not\s+a\s+limit/i);
  });

  /**
   * THE ROUTE TABLE, AND THE THREE ROWS THAT MUST NOT COME BACK.
   *
   * The admin code routes are unmounted and the modules deleted, so a README naming them would send
   * an operator to three 404s. `mount.test.ts` holds the server end of the same claim.
   */
  it('documents the account routes, and none of the retired ones', () => {
    for (const route of [
      'POST /api/auth/enroll',
      'POST /api/auth/bootstrap',
      'POST /api/admin/users',
    ]) {
      expect(readme, route).toContain(route);
    }
    for (const gone of [
      '/api/admin/enrollment-codes',
      '/api/auth/enrollment-open',
    ]) {
      expect(readme, `${gone} is documented again and does not exist`).not.toContain(gone);
    }
    // The one response that used to carry a code's plaintext is gone with it; the generated
    // password is the only shown-once secret left, and the table still has to say so.
    expect(readme).toMatch(/password shown once/i);
    expect(readme).not.toMatch(/carries `plaintext`/);
  });

  /**
   * THE ONE ROW IN THAT TABLE THAT PRINTS A RESPONSE BODY, HELD TO THE BODY THE ROUTE SENDS.
   *
   * It said `{ needsSetup: boolean }`. The route has answered `{ required: … }` since it was
   * written — `res.json({ required: deps.bootstrap.required() })` — so anybody building against
   * this table read `undefined` and concluded the instance was set up. Nothing caught it: the row
   * is prose, the field name appears nowhere else, and the SPA calls its own typed client.
   *
   * A shape transcribed into a document is a copy that can drift, so this one is not transcribed:
   * the key is read out of `api/auth.ts` and the README is required to print whatever it finds.
   */
  it('prints the bootstrap-status body the route actually sends', () => {
    const route = readFileSync(resolve(REPO_ROOT, 'packages/server/src/api/auth.ts'), 'utf8');
    const key = /'\/auth\/bootstrap-status'[\s\S]{0,300}?res\.json\(\{\s*(\w+):/.exec(route)?.[1];
    expect(key, 'the bootstrap-status handler is no longer in a shape this test can read').toBeTruthy();
    expect(readme).toContain(`\`{ ${String(key)}: boolean }\``);
  });
});

/**
 * THE BANNER IS THE OTHER DOCUMENT THAT CARRIED THE RETIRED CLAIM, AND ITS READER CANNOT ASK A
 * FOLLOW-UP QUESTION.
 *
 * It is printed once, into a container log, to an operator who has just started an image they did
 * not write. It said `There is no public signup.`, then it said an administrator issues an
 * enrollment code somebody signs up with, and both sentences have now been outlived by the product.
 * `firstRunBanner` is exported precisely so this file can hold it to the same standard as the
 * README rather than trusting a code comment.
 *
 * WHAT THE PARAMETER IS NOW. It was the token and it is the PATH the token was written to:
 * `bootstrap.ts` stopped printing a live credential into a log that keeps it for the life of the
 * container. The type did not change, so nothing here failed to compile — which is why the
 * assertions below had to be re-pointed by hand rather than by the compiler.
 *
 * The awk test at the bottom is the one that has failed for real. The README's command was
 * `grep -A4 'first-run setup'` when the banner was five lines, and printed everything except the
 * token by the time it was eight — the standard failure of a fixed-line-count reader. So the
 * command is not described here, it is extracted from the README and run. What it must yield
 * changed with the banner: the token is not in the log at all now, so the thing to find is the
 * PATH, and finding a token here would mean the file write had silently stopped happening.
 */
describe('the first-boot banner an operator reads in a container log', () => {
  const tokenPath = '/data/first-run-token.txt';
  const banner = firstRunBanner(tokenPath);
  const lines = banner.split('\n');

  /**
   * BOTH OF THIS TEST'S ORIGINAL ASSERTIONS ARE NOW REFUSALS, AND NEITHER WAS FAILING WHEN IT WAS
   * CHANGED. It required `enrollment code` and `no open sign-up` to be in the banner, which was an
   * accurate description of the product on 2026-08-10. Sign-up is open and codes are retired, so a
   * banner still saying either would be a false statement made to the reader least able to check
   * it — the same failure the sentence it replaced (`There is no public signup.`) had.
   */
  it('no longer tells the operator about a door that has been removed', () => {
    expect(banner).not.toMatch(/no public sign-?up/i);
    expect(banner).not.toMatch(/no open sign-?up/i);
    expect(banner).not.toMatch(/enrollment code/i);
    // What must be there instead: where the token is, and the one fact that is still a security
    // property rather than a boast — nothing can create an account until the administrator exists.
    expect(banner).toContain(tokenPath);
    expect(banner).toMatch(/not printed in this log/i);
    expect(banner).toMatch(/until it does/i);
  });

  it('stays short and plain enough for a log', () => {
    // No line wider than the rule it is printed under; the banner's own delimiter is the budget.
    expect(lines[0]).toMatch(/^={20,}$/);
    for (const line of lines) expect(line.length, line).toBeLessThanOrEqual(lines[0]!.length);
    expect(lines.length).toBeLessThanOrEqual(24);
    // ASCII only. This lands in journald, `docker logs`, a CI transcript and somebody's PuTTY.
    expect(banner).toMatch(/^[\x20-\x7e\n]+$/);
  });

  it('yields the banner — and not a token — to the exact command the README prints', () => {
    const program = /\| awk '([^']+)'/.exec(readme)?.[1];
    expect(
      program,
      "the README's log-reading command is no longer an awk one-liner this test can run; if it " +
        'changed shape, this test has to change with it rather than be deleted',
    ).toBeTruthy();

    // Fed the way the operator feeds it: a log with the banner somewhere in the middle of it.
    // Running it against the banner alone would pass with no closing delimiter at all — awk would
    // simply print to EOF — and "prints the rest of your log" is a different broken command.
    const log = [
      '2026-08-04T09:00:00Z GrantSpotter 0.1.0 starting',
      banner,
      '2026-08-04T09:00:01Z listening on 0.0.0.0:3030',
      '2026-08-04T09:00:09Z GET /api/auth/me 401',
    ].join('\n');
    const printed = execFileSync('awk', [program!], { input: log, encoding: 'utf8' });

    expect(printed).toContain(tokenPath);
    expect(printed).toContain('GrantSpotter first-run setup');
    // A 48-hex-character run is what the token looks like. Finding one HERE would mean the token
    // was back in the log, which is the whole thing this change was for.
    expect(printed).not.toMatch(/\b[0-9a-f]{48}\b/);
    // It stops at the closing delimiter instead of running on.
    expect(printed).not.toContain('listening on');
    expect(printed.trimEnd().split('\n').at(-1)).toMatch(/^={20,}$/);
  });
});
