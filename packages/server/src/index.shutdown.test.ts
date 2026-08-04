import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * DOES THE SERVER STOP WHEN THE CONTAINER TELLS IT TO?
 *
 * This is a deployment defect, so it is tested against the real entrypoint rather than against an
 * extracted helper. The bug was not in any function's logic — it was in the wiring:
 * `index.ts` registered `process.on('SIGTERM', () => crawlScheduler.stop())`, which is a perfectly
 * correct call that does the wrong thing, because registering ANY listener for SIGTERM replaces
 * Node's default terminate-on-SIGTERM. The scheduler stopped and the process kept listening. A
 * unit test of a `shutdown()` function would have passed against that code, since there was no
 * such function to get wrong; only spawning the actual binary and signalling it can tell.
 *
 * What it costs the deployment when this regresses: `docker stop` sends SIGTERM, waits the full
 * grace period (10s by default), then SIGKILLs. Every deploy and every restart therefore takes ten
 * seconds longer than it should and ends in SIGKILL, which is the way to leave a WAL-mode SQLite
 * database mid-write. The assertions below are the two halves of "it stopped": an exit that
 * happens WELL INSIDE that grace period, and a SUCCESS code rather than the 143 that says the
 * kernel did it.
 */

const ENTRYPOINT = fileURLToPath(new URL('./index.ts', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Well inside docker's 10s default grace period, and generous enough not to be flaky here. */
const MUST_EXIT_WITHIN_MS = 6_000;

/** Every process this file started, and every throwaway directory it wrote, so nothing survives it. */
const started: ChildProcessWithoutNullStreams[] = [];
const dataDirs: string[] = [];

afterEach(() => {
  for (const proc of started.splice(0)) {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  }
  for (const dir of dataDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Boot the real entrypoint on a throwaway database and resolve once it is listening.
 *
 * `tsx` rather than `dist/`: this suite must not depend on a build step having been run, and the
 * shutdown path is identical either way — `node --import tsx` runs the same module graph.
 */
async function bootServer(port: number): Promise<ChildProcessWithoutNullStreams> {
  const dataDir = mkdtempSync(join(tmpdir(), 'grantspotter-shutdown-'));
  dataDirs.push(dataDir);
  const proc = spawn(
    process.execPath,
    ['--import', 'tsx', ENTRYPOINT],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        DATA_DIR: dataDir,
        SESSION_SECRET: 'shutdown-test-session-secret-not-a-real-secret',
        // Required with no default since 2026-08-04, so this had to become explicit: the server
        // will not start without it, and inheriting whatever is in the developer's shell would
        // make whether this test can boot depend on their environment.
        CONTACT_URL: 'https://w9xyz-radio-club.org/grantspotter',
        // No scheduler: this test is about stopping, and a crawl would reach the network.
        CRAWL_ENABLED: 'false',
      },
    },
  ) as ChildProcessWithoutNullStreams;
  started.push(proc);

  let log = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`server never announced itself in 60s. Output so far:\n${log}`));
    }, 60_000);
    const onData = (chunk: Buffer): void => {
      log += chunk.toString();
      if (log.includes('listening on port')) {
        clearTimeout(timer);
        resolve();
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited with ${String(code)} before listening. Output:\n${log}`));
    });
  });
  return proc;
}

function waitForExit(
  proc: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; ms: number }> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `the process was still alive ${String(timeoutMs)}ms after the signal. This is the ` +
            'defect: SIGTERM stops the scheduler but never exits, so docker stop burns its whole ' +
            'grace period and then SIGKILLs.',
        ),
      );
    }, timeoutMs);
    proc.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, ms: Date.now() - started });
    });
  });
}

describe('the server entrypoint on SIGTERM', () => {
  it('exits promptly and successfully rather than ignoring the signal', async () => {
    const proc = await bootServer(3221);

    let output = '';
    proc.stdout.on('data', (c: Buffer) => (output += c.toString()));

    proc.kill('SIGTERM');
    const exit = await waitForExit(proc, MUST_EXIT_WITHIN_MS);

    // Exited on its own, not because the kernel killed it: `signal` is null and the code is 0.
    // A process SIGKILLed after the grace period reports signal 'SIGKILL' and code null, which is
    // exactly the state this test exists to forbid.
    expect(exit.signal).toBeNull();
    expect(exit.code).toBe(0);
    expect(exit.ms).toBeLessThan(MUST_EXIT_WITHIN_MS);

    // And it said what it did, so an operator reading `docker logs` can tell a clean stop from a
    // crash. The database close is the part that checkpoints the WAL back into the main file.
    expect(output).toContain('SIGTERM received');
    expect(output).toContain('stopped cleanly');
  }, 90_000);

  it('stops on SIGINT too, so Ctrl-C in dev is not a kill -9', async () => {
    const proc = await bootServer(3222);
    proc.kill('SIGINT');
    const exit = await waitForExit(proc, MUST_EXIT_WITHIN_MS);
    expect(exit.signal).toBeNull();
    expect(exit.code).toBe(0);
  }, 90_000);

  it('releases the port, so the next container can bind it', async () => {
    const port = 3223;
    const first = await bootServer(port);
    first.kill('SIGTERM');
    await waitForExit(first, MUST_EXIT_WITHIN_MS);

    // The real consequence of a listener that is never closed: a restart that cannot bind. If the
    // previous process were still up, or had leaked its socket, this boot would die on EADDRINUSE.
    const second = await bootServer(port);
    second.kill('SIGTERM');
    const exit = await waitForExit(second, MUST_EXIT_WITHIN_MS);
    expect(exit.code).toBe(0);
  }, 120_000);
});
