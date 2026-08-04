import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * THE IMAGE IS NEVER BUILT ON THIS HOST. There is no Docker daemon here, so the only thing that
 * can catch a mistake in the Dockerfile before CI spends fifteen minutes on an emulated arm64
 * build is a test that reads it as text. That is what this file is: the properties that matter —
 * pinned base image, multi-stage, non-root, healthcheck with no extra binary, every runtime asset
 * the app reads from disk actually COPYed, and no browser engine — asserted against the file.
 *
 * The COPY-sources check below is the one that would have caught the real failure mode: a COPY
 * whose source does not exist in the build context aborts `docker build`, and the first time
 * anyone would learn that is in CI.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
const dockerfile = readFileSync(resolve(REPO_ROOT, 'Dockerfile'), 'utf8');
const dockerignore = readFileSync(resolve(REPO_ROOT, '.dockerignore'), 'utf8');

describe('Dockerfile', () => {
  it('pins the exact Node version the project is built against', () => {
    expect(dockerfile).toContain('node:20.11.0');
    expect(dockerfile).not.toMatch(/FROM node:(latest|20\s|20-)/);
  });

  it('is multi-stage', () => {
    const stages = dockerfile.match(/^FROM .+ AS \w+/gm) ?? [];
    expect(stages.length).toBeGreaterThanOrEqual(2);
  });

  it('installs the toolchain better-sqlite3 needs to compile', () => {
    expect(dockerfile).toMatch(/python3/);
    // `\bg\+\+\b` — the obvious spelling, and the one this task's brief carried — can never
    // match the package name: `\b` after `+` demands a WORD character next, so it matches
    // `g++11` and never `g++ ` or `g++` at end of line. This asserts the standalone token.
    expect(dockerfile).toMatch(/(?<![\w+])g\+\+(?![\w+])/);
    expect(dockerfile).toMatch(/\bmake\b/);
  });

  it('drops to a non-root user before CMD', () => {
    // Anchored to line starts. `indexOf('USER node')` — the brief's spelling — is satisfied by
    // `# USER node`, so commenting the instruction out and shipping a root container passed.
    // Proven on 2026-08-04 by doing exactly that: 16/16 green with the line commented.
    const userIndex = dockerfile.search(/^USER node\s*$/m);
    const cmdMatches = [...dockerfile.matchAll(/^CMD /gm)];
    const cmdIndex = cmdMatches.length > 0 ? (cmdMatches[cmdMatches.length - 1]?.index ?? -1) : -1;
    expect(userIndex).toBeGreaterThan(-1);
    expect(cmdIndex).toBeGreaterThan(userIndex);
  });

  it('declares a healthcheck that needs no extra binary', () => {
    expect(dockerfile).toContain('HEALTHCHECK');
    expect(dockerfile).not.toMatch(/HEALTHCHECK[\s\S]{0,200}(curl|wget)/);
  });

  it('ships the runtime assets the app reads from disk', () => {
    expect(dockerfile).toMatch(/COPY .*content .*\/content/);
    expect(dockerfile).toMatch(/COPY .*data\/seed/);
    expect(dockerfile).toMatch(/COPY .*data\/reference/);
    expect(dockerfile).toMatch(/packages\/web\/dist/);
  });

  it("bundles no browser: PDF is the user's own print dialog", () => {
    for (const forbidden of ['chromium', 'chrome', 'puppeteer', 'playwright']) {
      expect(dockerfile.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('sets DATA_DIR and declares the volume', () => {
    expect(dockerfile).toMatch(/ENV[\s\S]{0,200}DATA_DIR=\/data/);
    expect(dockerfile).toContain('VOLUME');
  });

  it('bakes in no secret and no host-specific value', () => {
    expect(dockerfile).not.toMatch(/SESSION_SECRET=\S/);
    expect(dockerfile).not.toMatch(/ANTHROPIC_API_KEY=\S/);
    expect(dockerfile).not.toMatch(/\/home\/[a-z0-9_-]+\//i);
    expect(dockerfile).not.toMatch(/\b(?:192\.168|10)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
  });

  it('excludes local state and the build context noise', () => {
    for (const entry of ['node_modules', '.git', 'dist', '.env', 'data/*.sqlite']) {
      expect(dockerignore).toContain(entry);
    }
  });
});

/** Build-context COPY sources: every `COPY <src>… <dst>` that is not `COPY --from=<stage>`. */
function buildContextCopySources(text: string): string[] {
  const sources: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('COPY ')) continue;
    if (/^COPY\s+--from=/.test(trimmed)) continue;
    const args = trimmed
      .slice('COPY '.length)
      .split(/\s+/)
      .filter((a) => a.length > 0 && !a.startsWith('--'));
    // The last argument is the destination inside the image.
    for (const src of args.slice(0, -1)) sources.push(src);
  }
  return sources;
}

describe('Dockerfile COPY sources', () => {
  const sources = buildContextCopySources(dockerfile);

  it('names at least the workspace manifests and the runtime assets', () => {
    // Vacuity guard: a parser that found nothing would make every check below pass.
    expect(sources.length).toBeGreaterThan(5);
    expect(sources).toContain('content');
  });

  it('copies only paths that exist in the build context', () => {
    // A COPY whose source is absent aborts `docker build` — in CI, after the slow arm64 stage.
    // Existence is checked here; being COMMITTED is the other half and cannot be checked from a
    // working tree that legitimately holds uncommitted work. CI builds from a git checkout, so a
    // present-but-untracked directory named here would fail the build and pass this test.
    const missing = sources.filter((src) => src !== '.' && !existsSync(resolve(REPO_ROOT, src)));
    expect(missing).toEqual([]);
  });
});

describe('Dockerfile runtime layout', () => {
  it('starts the compiled server entry point that the build stage produces', () => {
    expect(dockerfile).toMatch(/CMD \["node", "packages\/server\/dist\/index\.js"\]/);
    // `seedDir()` and `webDistRoot()` both walk four/three levels up from the compiled module, so
    // the container layout has to mirror the repository: /app/packages/server/dist/… beside
    // /app/data and /app/packages/web/dist.
    expect(dockerfile).toMatch(/COPY --from=build \/app\/packages\/server\/dist \.\/packages\/server\/dist/);
    expect(dockerfile).toMatch(/COPY --from=build \/app\/packages\/web\/dist \.\/packages\/web\/dist/);
    expect(dockerfile).toMatch(/COPY --from=build \/app\/packages\/core\/dist \.\/packages\/core\/dist/);
  });

  it('ships each workspace manifest, because node_modules resolves them through symlinks', () => {
    // npm workspaces link node_modules/@grantspotter/core → ../../packages/core. Without the
    // package.json at the far end of that link, `import '@grantspotter/core'` resolves to nothing.
    for (const pkg of ['core', 'server', 'web']) {
      expect(dockerfile).toContain(`packages/${pkg}/package.json`);
    }
  });

  it('copies only from stages that exist', () => {
    const stages = new Set(
      [...dockerfile.matchAll(/^FROM \S+ AS (\w+)/gm)].map((m) => (m[1] as string).toLowerCase()),
    );
    const froms = [...dockerfile.matchAll(/COPY\s+--from=(\S+)/g)].map((m) =>
      (m[1] as string).toLowerCase(),
    );
    expect(stages.size).toBeGreaterThanOrEqual(3);
    expect(froms.length).toBeGreaterThan(0);
    // `--from=biuld` is not an error at parse time: BuildKit treats an unknown name as an image
    // reference and goes to the registry for it.
    for (const from of froms) expect(stages).toContain(from);
  });

  it('runs the whole app as one process on the port compose publishes', () => {
    expect(dockerfile).toMatch(/PORT=3030/);
    expect(dockerfile).toMatch(/EXPOSE 3030/);
  });
});
