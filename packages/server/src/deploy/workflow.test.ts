import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The workflow's first execution happens after the single push that ends this project, so it has
 * to be right on arrival — there is no "push and watch it go red" loop available here. These
 * assertions cover the parts that would only fail in that first run: the trigger, the token
 * permission, the verify-before-publish ordering, the Node version, the platform list, and the
 * registry path.
 *
 * The script-name check is the one that catches a typo silently: a `run: npm run typechek` step
 * fails the whole pipeline on line one, and nothing in this repository would have said so first.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
const wf = readFileSync(resolve(REPO_ROOT, '.github/workflows/build.yml'), 'utf8');
const rootPkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

describe('build workflow', () => {
  it('triggers on a push to master and on manual dispatch', () => {
    expect(wf).toMatch(/branches:\s*\[\s*master\s*\]/);
    expect(wf).toContain('workflow_dispatch:');
  });

  it('grants the token permission to write packages', () => {
    expect(wf).toMatch(/packages:\s*write/);
    expect(wf).toMatch(/contents:\s*read/);
  });

  it('verifies before it publishes', () => {
    expect(wf).toContain('npm run typecheck');
    expect(wf).toContain('npm run build');
    expect(wf).toContain('npm test');
    const verifyJob = wf.indexOf('verify:');
    const imageJob = wf.indexOf('image:');
    expect(verifyJob).toBeGreaterThan(-1);
    expect(imageJob).toBeGreaterThan(verifyJob);
    expect(wf).toMatch(/needs:\s*verify/);
  });

  it('uses the same Node version as the project', () => {
    expect(wf).toContain("node-version: '20.11.0'");
  });

  it('builds both architectures', () => {
    expect(wf).toContain('linux/amd64,linux/arm64');
    expect(wf).toContain('docker/setup-qemu-action');
    expect(wf).toContain('docker/setup-buildx-action');
  });

  it('publishes the latest tag to the right GHCR path', () => {
    expect(wf).toContain('ghcr.io/atvriders/grantspotter:latest');
    expect(wf).toContain('ghcr.io');
    expect(wf).toContain('docker/login-action');
  });

  it('caches layers so the emulated arm64 build is not rebuilt from scratch', () => {
    expect(wf).toContain('cache-from: type=gha');
    expect(wf).toContain('cache-to: type=gha');
  });

  it('links the package to the repository so it inherits public visibility', () => {
    expect(wf).toContain('org.opencontainers.image.source');
  });

  it('does not run the live source check or the e2e suite in CI', () => {
    expect(wf).not.toContain('verify-sources');
    expect(wf).not.toContain('test:e2e');
  });

  it('contains no hardcoded secret', () => {
    expect(wf).not.toMatch(/gh[pous]_[A-Za-z0-9]{20,}/);
    expect(wf).toContain('${{ secrets.GITHUB_TOKEN }}');
  });
});

describe('build workflow — the steps it names must exist', () => {
  /** Every `npm run <script>` the workflow invokes. */
  const invoked = [...wf.matchAll(/npm run ([a-z0-9:_-]+)/g)].map((m) => m[1] as string);

  it('invokes at least the three verification scripts', () => {
    // Vacuity guard: an empty match set would make the next assertion pass on nothing.
    expect(invoked).toContain('typecheck');
    expect(invoked).toContain('build');
  });

  it('names only scripts that exist in the root package.json', () => {
    const unknown = invoked.filter((name) => !(name in rootPkg.scripts));
    expect(unknown).toEqual([]);
  });

  it('runs the whole suite: the test step is never narrowed to a project or a path', () => {
    // A reviewer once turned `vitest run` into `vitest run --project server` and dropped 653 web
    // tests while every gate stayed green (test/vitestCoverageContract.test.ts documents it). The
    // same defeat is one flag away in a workflow step, where no other invariant is watching.
    const testSteps = [...wf.matchAll(/^\s*run:\s*(npm (?:run )?test\b.*)$/gm)].map((m) =>
      (m[1] as string).trim(),
    );
    expect(testSteps.length).toBeGreaterThan(0);
    for (const step of testSteps) {
      expect(step).toBe('npm test');
    }
  });

  it('installs with the lockfile, not a resolving install', () => {
    expect(wf).toMatch(/^\s*run:\s*npm ci\s*$/m);
    expect(wf).not.toMatch(/^\s*run:\s*npm i(nstall)?\s*$/m);
  });
});

describe('build workflow — nothing host-specific', () => {
  it('carries no real LAN address, hostname or host path', () => {
    expect(wf).not.toMatch(/\b(?:192\.168|10)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    expect(wf).not.toMatch(/\/home\/[a-z0-9_-]+\//i);
    expect(wf).not.toMatch(/\/mnt\/user\//);
  });

  it('pins every third-party action to a major version', () => {
    const uses = [...wf.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1] as string);
    expect(uses.length).toBeGreaterThan(3);
    for (const action of uses) {
      expect(action).toMatch(/@v\d+$/);
    }
  });
});
