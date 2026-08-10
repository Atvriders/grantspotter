import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { firstRunBanner } from '../auth/bootstrap.js';
import {
  ENV_CODE_DEFAULT_DAYS,
  ENV_CODE_DEFAULT_MAX_USES,
  ENV_CODE_LABEL,
} from '../auth/chosenCode.js';
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
      'ENROLLMENT_CODE',
      'ENROLLMENT_CODE_MAX_USES',
      'ENROLLMENT_CODE_DAYS',
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
   * THE ASSERTION THAT USED TO BE HERE WAS NOT WRONG. THE PRODUCT CHANGED UNDER IT.
   *
   * It required the README to say `no sign-up form`, and for the life of this project that was an
   * accurate description of a deliberate design: `createBootstrapState` printed a one-time token to
   * the log, `POST /api/auth/bootstrap` was the only thing that could spend it, and every later
   * account came from an administrator typing it into **Admin → User accounts**. The comment above
   * it said the claim was "unchanged and still meaningful", and it was.
   *
   * Enrollment codes make it false. A person holding a code an administrator issued now creates
   * their own account, at a form, without an administrator present. So the sentence goes — but the
   * property it was protecting does not, and losing it in the edit would be the actual regression:
   * "GrantSpotter has sign-up now" is exactly the wrong summary of this change. What is true is
   * narrower and harder, and it is what the `enrolment is a third door` block below holds:
   * registration is impossible without a secret an administrator issued, limited, and can revoke.
   *
   * So this test keeps the two claims about the bootstrap path that are still true — the token has
   * a documented way to spend it, and the first administrator comes from the log and cannot come
   * from anywhere else — and hands the sign-up question to gates written for the new design.
   */
  it('says how to spend the bootstrap token, not just where to find it', () => {
    expect(readme).toContain('/api/auth/bootstrap');
    // The screen exists; a README that still called it API-only would be the product's front page
    // contradicting the product.
    expect(readme).toMatch(/first-run screen/i);
    // `\s+` and not a space throughout: these sentences wrap mid-phrase in the source, and a regex
    // that assumes one line would fail on a reflow that changed nothing a reader can see.
    expect(readme).toMatch(/first\s+administrator\s+always\s*\n?\s*comes\s+from\s+the\s+log/i);
    // …and why it cannot be otherwise, which is the sentence that stops enrolment being mistaken
    // for a way to stand an instance up.
    expect(readme).toMatch(/enrolment\s+(therefore\s+)?cannot\s+bootstrap/i);
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
    const documented: Record<string, string> = {
      callsign: 'Callsign',
      state: 'State',
      licenseClass: 'License class',
      orgName: 'Organization name',
    };
    expect(new Set(written)).toEqual(new Set(Object.keys(documented)));

    expect(readme).toMatch(/four values, and only four/i);
    for (const label of Object.values(documented)) {
      expect(readme, label).toContain(`**${label}**`);
    }
    // …and it says, in the same breath, why the rest of the record is not on that list.
    expect(readme).toMatch(/no street field, no\s*\n?\s*city field, no ZIP field/i);
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
describe('README: enrolment is a third door, not an open one', () => {
  it('no longer claims there is no way for a user to create an account', () => {
    // Every form of the retired claim, starting with the exact one this file asserted for the
    // whole life of the project up to this change.
    expect(readme).not.toMatch(/no\s+sign-?up\s+form/i);
    expect(readme).not.toMatch(/there\s+is\s+no\s+public\s+sign-?up/i);
    expect(readme).not.toMatch(/no\s+public\s+sign-?up\s+by\s+default/i);
    expect(readme).not.toMatch(/only\s+an?\s+admin\w*\s+can\s+(create|make)\s+an?\s+account/i);
    expect(readme).not.toMatch(/cannot\s+(create|make)\s+(their|your)\s+own\s+account/i);
    // And the capability that replaced them, said plainly enough to find.
    expect(readme).toMatch(/creates?\s+their\s+own\s+account/i);
    expect(readme).toMatch(/\benrol/i);
  });

  it('does not claim sign-up is open', () => {
    expect(readme).not.toMatch(/any(one|body)\s+can\s+(create|register|sign\s?-?\s?up|make)/i);
    expect(readme).not.toMatch(/(sign-?up|registration)\s+is\s+(now\s+)?(open|public|enabled)/i);
    expect(readme).not.toMatch(/now\s+has\s+(public\s+)?sign-?up/i);
    expect(readme).not.toMatch(/open\s+to\s+(the\s+public|anyone)/i);
    // The qualifier that carries the design, in the words that mean it rather than an adjective.
    expect(readme).toMatch(/no\s+open\s+sign-?up/i);
    expect(readme).toMatch(/code\s+(that\s+)?an\s+administrator\s+issued/i);
    // The three paths, counted, so a fourth cannot appear in the product without appearing here.
    expect(readme).toMatch(/three things can bring an account into existence/i);
    expect(readme).toMatch(/not one of them is open registration/i);
  });

  it('keeps the first-run token as the only way to the first administrator', () => {
    expect(readme).toMatch(/first\s+administrator\s+always\s*\n?\s*comes\s+from\s+the\s+log/i);
    expect(readme).toMatch(/nobody\s+who\s+could\s+issue\s+an?\s*\n?\s*\[?enrollment code/i);
    // The in-page link the Deploying section leans on. A dangling anchor is how the qualifier gets
    // lost from the one section an operator actually reads.
    expect(readme).toContain('(#enrollment-codes)');
    expect(readme).toMatch(/^### Enrollment codes$/m);
  });

  /**
   * The README tells an administrator where to go, so it is bound to the heading that screen
   * actually carries — the same arrangement as `names exactly the fields the lookup actually
   * fills`, which reads `callsignFill.ts` rather than trusting a sentence. A renamed panel and an
   * unrenamed instruction is a small lie that costs somebody a real search.
   */
  it('names the admin screen by the heading that screen actually carries', () => {
    const panel = readFileSync(
      resolve(REPO_ROOT, 'packages/web/src/components/EnrollmentCodes.tsx'),
      'utf8',
    );
    const heading = /<h2>([^<]+)<\/h2>/.exec(panel)?.[1];
    expect(heading, 'no <h2> found in the enrollment codes panel').toBeTruthy();
    expect(readme).toContain(`**Admin → ${heading}**`);
  });

  it('says the code is shown once and is then unreadable, like every other secret here', () => {
    expect(readme).toMatch(/shown\s+exactly\s+once/i);
    expect(readme).toMatch(/only\s+a\s+hash\s+of\s+it\s+is\s*\n?\s*stored/i);
    expect(readme).toMatch(/cannot\s+show\s+you\s+the\s+code/i);
    // The precedent, named: `POST /api/admin/users` has done this since it shipped, and a reader
    // meeting the second instance of a rule should be told it is the same rule.
    expect(readme).toMatch(/password\s+shown\s+once/i);
    // No recovery path may be implied, because none exists.
    expect(readme).not.toMatch(/(view|read|retrieve|recover)\s+the\s+code\s+(again|later)/i);
    expect(readme).toMatch(/revoke it and issue another/i);
    // Revocation is stamped rather than deleted — the same shape as `ics_tokens.revoked_at`.
    expect(readme).toMatch(/stamps? the row rather than deleting it/i);
  });

  it('says enrolment produces a member and that the request cannot ask for more', () => {
    expect(readme).toMatch(/role\s+is\s+not\s+a\s+parameter\s+of\s+the\s+request/i);
    expect(readme).toMatch(/gets\s+`member`/);
    expect(readme).toMatch(/only\s+way\s+to\s+a\s+second\s+administrator/i);
    // The password floor is one policy in this codebase, and the README must not read as if
    // enrolment brought its own.
    expect(readme).toMatch(/same\s+12-character\s+floor/i);
  });

  /**
   * TWO ASSERTIONS IN THIS BLOCK CHANGED ON 2026-08-10 BECAUSE THE CLAIM THEY PINNED WAS FALSE,
   * not because they were failing. They were green, and what they held green was a README sentence
   * the product contradicts.
   *
   * They required the README to say that enrolment counts failures "against enrolment as a whole
   * rather than against the caller", and that the price of that is "a burst of wrong guesses makes
   * the next honest person wait". Neither is what `POST /api/auth/enroll` does:
   *
   *   · the budget is keyed on `reportedOrigin(req)` — the caller — in `api/auth.ts`, and has been
   *     since 2026-08-05, when counting against enrolment as a whole was removed for closing every
   *     club's intake on ten requests from one stranger who held no code at all;
   *   · nothing but the "that code is not valid" branch consults it, so a holder of a code this
   *     instance issued never reads it and cannot be made to wait by anybody. `enroll.test.ts`
   *     pins both halves — `does not let a stranger's wrong codes close enrolment for somebody
   *     with a real one`, and `spends one connection's guesses without spending another's`;
   *   · and the refusal the product prints says so to the user's face: "Too many enrollment codes
   *     have been tried from this connection recently."
   *
   * The accurate wording already existed one directory away, in the note over
   * `ENROLLMENT_MAX_FAILURES`; only the README and this file had missed the change. So the README
   * was rewritten to the measured behaviour, these assertions were re-pointed at it, and two of
   * them now REFUSE the retired sentences by name — a claim that survived one green suite can
   * survive another.
   *
   * THIS IS THE SECOND DOC GATE IN THIS FILE TO HAVE REQUIRED A FALSE STATEMENT. The first was the
   * corpus statistic above (`marks the projected calendar dates as projected…`), which demanded
   * "4 of the 243" and thereby kept a wrong figure on the project's front page with a green suite
   * pointing at it. Same failure twice: an assertion written from the prose instead of from the
   * thing the prose is about. A doc gate should pin the honesty, never the arithmetic — and where
   * it must pin a number, it should read that number out of the source, as the budget does below.
   */
  /**
   * A THIRD TIME, AND THIS ONE IS NOT THE README BEING BEHIND THE CODE — IT IS THE CLAIM ITSELF
   * BEING WITHDRAWN.
   *
   * This test was named for "the two properties that make a typed-in secret worth anything" and
   * demanded the sentence "a secret you can only attack by guessing is worth the number of guesses
   * allowed". That is the reasoning the product has stopped making. It was sound while every code
   * was 2^100 and it is not a defence of `W1MX-FALL-2026`: measured on 2026-08-10, one machine
   * rotating `X-Forwarded-For` was answered 20,008 wrong codes in 10.12 s, because the budget the
   * sentence was about was keyed on an address the caller writes.
   *
   * TWO ASSERTIONS ARE THEREFORE REPLACED RATHER THAN RELAXED, AND BOTH WERE TRUE WHEN WRITTEN.
   * "Counted against the caller and not against enrolment as a whole" is now FALSE of the shipped
   * server — there is a deployment-wide rung, deliberately, and a README that denied it would be
   * this file's own subject. "Worth the number of guesses allowed" is withdrawn as an argument.
   * What replaces them is stricter, not looser: all three ceilings are read out of `api/auth.ts`,
   * the property that keeps the deployment-wide one out of one caller's reach is required in
   * words, and the retired sentences are refused by name below.
   */
  it('states what actually bounds a code somebody typed, and what does not', () => {
    // The three ceilings, read out of the route rather than transcribed here. A README that quotes
    // ten guesses against a route that allows thirty is precisely this file's subject.
    const route = readFileSync(resolve(REPO_ROOT, 'packages/server/src/api/auth.ts'), 'utf8');
    const perAddress = /ENROLLMENT_MAX_FAILURES = (\d+)/.exec(route)?.[1];
    const perNetwork = /ENROLLMENT_MAX_FAILURES_PER_NETWORK = (\d+)/.exec(route)?.[1];
    const perServer = /ENROLLMENT_MAX_FAILURES_DEPLOYMENT = (\d+)/.exec(route)?.[1];
    const windowMin = /ENROLLMENT_WINDOW_MS = (\d+) \* 60 \* 1000/.exec(route)?.[1];
    for (const [name, value] of Object.entries({
      ENROLLMENT_MAX_FAILURES: perAddress,
      ENROLLMENT_MAX_FAILURES_PER_NETWORK: perNetwork,
      ENROLLMENT_MAX_FAILURES_DEPLOYMENT: perServer,
      ENROLLMENT_WINDOW_MS: windowMin,
    })) {
      expect(value, `${name} is no longer a literal in the shape this test reads`).toBeTruthy();
    }
    expect(readme).toMatch(new RegExp(`\\b${String(perAddress)} wrong codes per address\\b`));
    expect(readme).toMatch(new RegExp(`\\b${String(perNetwork)} per source network\\b`));
    expect(readme).toMatch(new RegExp(`\\b${String(perServer)}\\s+across the whole server\\b`));
    expect(readme).toMatch(new RegExp(`\\b${String(windowMin)} minutes\\b`));
    // Who never touches any of them, which is the promise that makes a coarse ceiling affordable.
    expect(readme).toMatch(
      /nothing a stranger does with wrong\s+codes can stop your students enrolling/i,
    );
    // The property that keeps the deployment-wide rung out of any single caller's reach. Without
    // it, that rung is the 2026-08-05 off switch again and the README would be overselling it.
    expect(readme).toMatch(/closing that one takes at least two networks acting together/i);
    // The cost that IS real, because a doc that states only the benefit is the half-sentence this
    // file exists to stop: one campus NAT is one budget, and a mistype from it can be told to wait.
    expect(readme).toMatch(/shares one budget/i);
    // The honest ceiling an attacker still has, in a number rather than a reassurance.
    expect(readme).toMatch(/23,040 a day/);
    // And the sentence the whole change is for: the floor is not what makes a chosen code safe.
    expect(readme).toMatch(/Clearing the floor does not make a code hard to\s+guess/i);
    // …and the retired claims, refused by name rather than merely unasserted.
    expect(
      /worth the\s+number of guesses allowed/i.test(readme),
      'The README is back to arguing that a chosen code is worth the number of guesses allowed. ' +
        'That was the argument for a 2^100 code and it is not a defence of W1MX-FALL-2026, which ' +
        'was found in seven guesses — see "the floor under a code an administrator chooses" in ' +
        'core/test/enrollmentCode.test.ts.',
    ).toBe(false);
    expect(
      /counted against the caller and not against enrolment as a whole/i.test(readme),
      'The README says the enrolment budget is only ever per-caller. Since 2026-08-10 there is a ' +
        'deployment-wide rung under it, because a caller who reaches the process directly picks ' +
        'their own per-caller key — see ENROLLMENT_MAX_FAILURES_DEPLOYMENT in api/auth.ts.',
    ).toBe(false);
    expect(
      /against enrolment as a whole\s+rather than against the caller/i.test(readme),
      'The README is back to calling the enrolment budget purely deployment-wide. The narrowest ' +
        'rung is still keyed on the caller, and has been since 2026-08-05, when the ' +
        'deployment-wide-only version was measured closing every club on the instance.',
    ).toBe(false);
    expect(
      /makes the next honest person wait/i.test(readme),
      'The README is back to saying a burst of wrong guesses makes the next honest person wait. ' +
        'A holder of a real code never reads any of these counters — see the two tests named in ' +
        'the note above this one in enroll.test.ts.',
    ).toBe(false);
    // Atomicity, as a claim a reader can check rather than a reassurance, and with the defect it
    // is guarding against named — this project shipped exactly this bug in the callsign lookup.
    expect(readme).toMatch(/at the same instant get one account, not two/i);
    expect(readme).toMatch(/one transaction/i);
    // The precedent, with the measurement rather than a paraphrase of it. `callsign.test.ts`
    // measured eight simultaneous presses making eight requests on 2026-08-04, and the README must
    // retell that as what it was — a guard that could not see an unanswered request — rather than
    // as a per-user limit, which is a different mechanism that was not the defect.
    expect(readme).toMatch(/eight simultaneous presses produced\s*\n?\s*eight requests/i);
    expect(readme).toMatch(/checked before an `await` and written after it is not a limit/i);
  });

  it('describes the non-enumeration rule, including what it deliberately does say', () => {
    expect(readme).toMatch(/wrong code and a code that was never issued get the same answer/i);
    expect(readme).toMatch(/not whether one exists, not how many/i);
    // The exception is not a leak and has to be documented as the deliberate thing it is: a
    // legitimate holder of a dead code needs to know which kind of dead it is.
    expect(readme).toMatch(/expired,?\s+revoked\s+and\s+used-up/i);
    // …and the public boolean must not be oversold into a fact about a particular code.
    expect(readme).toMatch(/single boolean about the instance/i);
    expect(readme).toMatch(/never issued one/i);
    // The limit of the promise, stated by the README rather than discovered by a reader who
    // assumed "no enumeration" covered everything. Enrolling with an address that already has an
    // account is told so, and a doc that implied otherwise would be overselling this.
    expect(readme).toMatch(/about codes, and not about email addresses/i);
    expect(readme).toMatch(/not a leak worth pretending about/i);
    // The limiter's exemption, which is a promise to the honest holder of a dead code. "Any of
    // them" and not "it": there are three counters now and the exemption has to cover all three,
    // or the promise is only true of the one a caller can rotate past anyway.
    expect(readme).toMatch(/only a wrong code is charged to any of them/i);
  });

  it('documents every route in the contract, with the one that returns the plaintext marked', () => {
    for (const route of [
      'GET /api/admin/enrollment-codes',
      'POST /api/admin/enrollment-codes',
      'POST /api/admin/enrollment-codes/:id/revoke',
      'GET /api/auth/enrollment-open',
      'POST /api/auth/enroll',
    ]) {
      expect(readme, route).toContain(route);
    }
    expect(readme).toMatch(/only response in the product that carries `plaintext`/i);
    expect(readme).toMatch(/carries no plaintext, ever/i);
    // The two nullable knobs, with the meaning of `null` spelled out. "maxUses?: number|null" is
    // ambiguous to everyone who has not read the handler.
    expect(readme).toContain('`maxUses: null` means no limit');
    expect(readme).toContain('`expiresAt: null` means no expiry');
    expect(readme).toMatch(/unrevoked, unexpired and under its limit/i);
  });

  /**
   * THE COMPOSE-FILE ROUTE IS A DOOR THIS SECTION HAS TO ACCOUNT FOR, AND THE FIRST THING IT HAS TO
   * GET RIGHT IS THAT IT IS NOT A NEW ONE.
   *
   * The `## Accounts` table above says three things can bring an account into existence and that
   * not one of them is open registration, and that claim is asserted verbatim elsewhere in this
   * file. `ENROLLMENT_CODE` produces an ordinary code row redeemed through the ordinary route, so
   * it is the THIRD path arriving by a second hand — and a README that let a reader count it as a
   * fourth would be describing a product with a self-serve door nobody issued.
   */
  /**
   * The README with its line wrapping, blockquote markers and emphasis removed.
   *
   * A doc gate should fail when a CLAIM goes, never when somebody re-wraps a paragraph or bolds a
   * word inside a sentence it was matching. Three of the assertions below quote whole sentences
   * that are longer than the file's 100-column wrap, so matching the raw text would make this
   * block a tax on editing prose rather than a guard on its content. The table rows are still
   * matched against the raw README, because there the backticks and pipes ARE the claim.
   */
  const flatten = (text: string): string =>
    text
      .replace(/^\s*>\s?/gm, ' ')
      .replace(/[*`]/g, '')
      .replace(/\s+/g, ' ');

  it('describes the compose-file route as the same third door, with the same bounds', () => {
    expect(readme).toContain('ENROLLMENT_CODE');
    expect(flatten(readme)).toMatch(/same third path and not a fourth/i);
    // The label is the row's identity AND the only thing that tells an administrator where a code
    // they did not issue came from, so the README must name it as the screen actually shows it.
    expect(readme).toContain(ENV_CODE_LABEL);
    // Read out of the code, never transcribed: a README quoting 30 uses against a file shipping 50
    // is precisely this suite's subject. Both the table row and the prose, because an operator
    // skimming for the number reads the first and an operator deciding reads the second.
    expect(readme).toMatch(
      new RegExp(`\`ENROLLMENT_CODE_MAX_USES\` \\| no \\| \`${String(ENV_CODE_DEFAULT_MAX_USES)}\``),
    );
    expect(readme).toMatch(
      new RegExp(`\`ENROLLMENT_CODE_DAYS\` \\| no \\| \`${String(ENV_CODE_DEFAULT_DAYS)}\``),
    );
    expect(flatten(readme)).toMatch(
      new RegExp(`ENROLLMENT_CODE_MAX_USES\\s*defaults to\\s*${String(ENV_CODE_DEFAULT_MAX_USES)}`),
    );
    expect(flatten(readme)).toMatch(
      new RegExp(`ENROLLMENT_CODE_DAYS\\s*to\\s*${String(ENV_CODE_DEFAULT_DAYS)}`),
    );
  });

  it('says what a restart, an edit and a deletion each do to the row', () => {
    // The four questions an operator asks in the order they ask them. Each is a real decision made
    // in `auth/envEnrollmentCode.ts`, and a README that skipped any of them would leave the
    // operator to find it out by watching a code stop working.
    const flat = flatten(readme);
    expect(flat).toMatch(/Restarting changes nothing/i);
    expect(flat).toMatch(/Changing the value withdraws the old code/i);
    expect(flat).toMatch(/deleting the value withdraws it/i);
    expect(flat).toMatch(/A withdrawn code never comes back/i);
    // And the one that is a security property rather than a convenience: nothing self-serve exists
    // before an administrator does, so the compose value cannot bootstrap an instance either.
    expect(flat).toMatch(/It cannot go first/i);
  });

  it('warns that the code sits in a tracked file, and why that one does not feel like a secret', () => {
    // NOT the session-secret paragraph. This is a second warning about a second value, and the
    // reason it needs its own is the asymmetry: an enrollment code is MEANT to be shared, so the
    // instinct that protects a secret does not fire. Nothing else in this suite gated a
    // tracked-file warning at all before this change.
    const section = flatten(
      readme.slice(readme.indexOf('### Enrollment codes'), readme.indexOf('## Deploying')),
    );
    expect(section.length, 'the enrolment section moved or went').toBeGreaterThan(2000);
    expect(section).toMatch(/tracked by git/i);
    expect(section).toMatch(/meant to be shared/i);
    expect(section).toMatch(/\.env/);
    expect(section).toMatch(/HOST_PORT/);
    // A worked example is the same accident in a smaller font, and the README says why it has none.
    expect(section).toMatch(/no example code/i);
  });
});

/**
 * THE BANNER IS THE OTHER DOCUMENT THAT CARRIED THE RETIRED CLAIM, AND ITS READER CANNOT ASK A
 * FOLLOW-UP QUESTION.
 *
 * It is printed once, into a container log, to an operator who has just started an image they did
 * not write. `There is no public signup.` was the last line they read, and after this change it
 * would be a lie told to the person least able to check it. `firstRunBanner` is exported precisely
 * so this file can hold it to the same standard as the README rather than trusting a code comment.
 *
 * The awk test at the bottom is the one that has failed for real. The README's command was
 * `grep -A4 'first-run setup'` when the banner was five lines, and printed everything except the
 * token by the time it was eight — the standard failure of a fixed-line-count reader. This change
 * grew the banner again, from 18 lines to 20, which is exactly the edit that used to break it. So
 * the command is not described here, it is extracted from the README and run.
 */
describe('the first-boot banner an operator reads in a container log', () => {
  const token = 'a1b2c3d4'.repeat(6); // the shape `randomBytes(24).toString('hex')` produces
  const banner = firstRunBanner(token);
  const lines = banner.split('\n');

  it('no longer tells the operator there is no public signup', () => {
    expect(banner).not.toMatch(/no public sign-?up/i);
    // What replaced it: the second door is named, and it is still not an open one.
    expect(banner).toMatch(/enrollment code/i);
    expect(banner).toMatch(/no open sign-?up/i);
    // It must stay a statement about who acts first, not a boast about security.
    expect(banner).toMatch(/an admin/i);
  });

  it('stays short and plain enough for a log', () => {
    // No line wider than the rule it is printed under; the banner's own delimiter is the budget.
    expect(lines[0]).toMatch(/^={20,}$/);
    for (const line of lines) expect(line.length, line).toBeLessThanOrEqual(lines[0]!.length);
    expect(lines.length).toBeLessThanOrEqual(24);
    // ASCII only. This lands in journald, `docker logs`, a CI transcript and somebody's PuTTY.
    expect(banner).toMatch(/^[\x20-\x7e\n]+$/);
  });

  it('still yields the token to the exact command the README prints', () => {
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

    expect(printed).toContain(token);
    expect(printed).toContain('GrantSpotter first-run setup');
    // It stops at the closing delimiter instead of running on.
    expect(printed).not.toContain('listening on');
    expect(printed.trimEnd().split('\n').at(-1)).toMatch(/^={20,}$/);
  });
});
