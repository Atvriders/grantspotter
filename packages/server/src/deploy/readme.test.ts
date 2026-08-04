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

  it('marks the projected calendar dates as projected', () => {
    expect(readme).toMatch(/243/);
    expect(readme).toMatch(/4 of (the )?243/);
    expect(readme).toMatch(/projected|recurrence/i);
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
