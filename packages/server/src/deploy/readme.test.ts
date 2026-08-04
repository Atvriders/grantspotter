import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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

  it('documents every environment variable and that two have no default', () => {
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
    expect(readme).toMatch(/no default/i);
    expect(readme).toMatch(/32 characters/);
    expect(readme).toMatch(/User-Agent/);
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
