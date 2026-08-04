/**
 * A real server process booted on the SHIPPED seed corpus — the corpus a fresh install has.
 *
 * WHY THIS EXISTS BESIDE `seed.ts` RATHER THAN REPLACING IT. The two builds are different
 * products and the browser suite only ever opened one of them:
 *
 *   `seed.ts`          → the committed FIXTURES, normalized through the source modules:
 *                        150 publishable + 553 suppressed rows, and CONTENT-HASHED ids. ARDC's
 *                        grants page is stored there as `ardc-grants--apply--b04e6201`,
 *                        named "Apply for a Grant".
 *   `importSeedIfEmpty`→ `data/seed/*.json` on the first boot of an empty DATA_DIR:
 *                        143 publishable + 0 suppressed rows, and CANONICAL ids. The same ARDC
 *                        programme is `ardc-grants`, named "ARDC Grants Program".
 *
 * (Both id figures were read out of the two databases, not transcribed from a plan.)
 *
 * So the two corpora disagree on the id in every deep link, and `packages/server/src/seed/
 * import.ts` treats the canonical ones as load-bearing: they are what lets Plan 2's `normalizeRaw`
 * resolve a seeded row through `ctx.existingIdFor` instead of minting a fresh id and inserting a
 * second copy of the whole corpus on the first nightly crawl. Until this harness existed, nothing
 * but a unit test ever opened that corpus, and no browser test ever opened the one a user will
 * actually have.
 *
 * The suppression boundary is the mirror image: the shipped corpus holds ZERO `do_not_publish`
 * rows, so it cannot exercise the four read-surface refusals at all. That is why the fixture specs
 * stay exactly as they are and this is additional coverage rather than a replacement.
 *
 * IT SPAWNS ITS OWN PROCESS INSTEAD OF ADDING A SECOND `webServer` ENTRY, for two reasons a
 * `webServer` entry cannot be talked into.
 *
 *   THE BOOT LOG IS EVIDENCE HERE, not noise. The one-time admin token exists nowhere but stdout —
 *   there is no sign-up form, and `/api/auth/bootstrap-status` will tell you a token is needed but
 *   never what it is — and the `[seed] …` sentence the operator reads is asserted verbatim.
 *   Playwright prefixes a `webServer`'s output with `[WebServer]` and prints it through the
 *   reporter; no fixture hands it to a spec.
 *
 *   THE SECOND BOOT HAPPENS MID-RUN. `webServer` starts processes before the first spec and stops
 *   them after the last, so "restart the container and prove nothing was imported twice" is not
 *   a shape it can express at all.
 *
 * Both boots then go through one mechanism rather than two. What this DOES depend on is the
 * default `webServer` command, which runs `npm run build && …` to completion before any spec
 * starts: `dist/` is therefore already built by the time `bootShippedServer` looks for it, and it
 * says so plainly if it is not.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import Database from 'better-sqlite3';

/**
 * Ports for the two boots, chosen next to `E2E_PORT` (3131) so the whole suite occupies one
 * contiguous block. Both must differ from it: the fixture server is still listening throughout.
 */
export const SHIPPED_PORT = 3132;
export const SHIPPED_SECOND_BOOT_PORT = 3133;
export const SHIPPED_BASE_URL = `http://127.0.0.1:${SHIPPED_PORT}`;

/**
 * The fresh install's DATA_DIR, nested INSIDE `e2e/.tmp/` on purpose.
 *
 * `.gitignore` ignores `e2e/.tmp/`, and a sibling directory would need a new ignore line in a file
 * this task does not own — an untracked SQLite database left in a public repository's working tree
 * is exactly the kind of thing that gets committed by a wide `git add`. Nesting also self-cleans:
 * `seed.ts` removes the whole of `e2e/.tmp` before it writes the fixture database, and it runs to
 * completion inside the default `webServer` command before any spec starts.
 */
export const SHIPPED_DATA_DIR = 'e2e/.tmp/shipped';
export const SHIPPED_DB_PATH = `${SHIPPED_DATA_DIR}/grantspotter.sqlite`;

/**
 * The first administrator, created the way an installation creates one: with the one-time token
 * the server prints while the users table is empty, spent against `POST /api/auth/bootstrap`. The
 * fixture harness never walks that route — `seed.ts` writes its three users straight into the
 * table — so until this file existed no test in this directory had created the first account the
 * way a fresh install has to.
 *
 * Deliberately over the API rather than through the first-run SCREEN, which now offers the same
 * exchange in the browser: every spec below needs a session before it starts, and a `beforeAll`
 * has no `page`. Driving the screen from the first spec instead would leave the other two
 * depending on a previous test's side effect and passing or failing on run order.
 */
export const OPERATOR_EMAIL = 'operator@example.com';
export const OPERATOR_PASSWORD = 'e2e-shipped-seed-password-not-a-real-secret';

const SERVER_ENTRY = 'packages/server/dist/index.js';
const WEB_INDEX = 'packages/web/dist/index.html';

/** Long enough for a cold boot on a loaded machine; a healthy one answers in a couple of seconds. */
const READY_TIMEOUT_MS = 60_000;

export interface BootedServer {
  /** Everything the process has written to stdout and stderr since it started. */
  output(): string;
  /** SIGTERM, then wait for the exit. Safe to call twice. */
  stop(): Promise<void>;
}

/**
 * The status `/api/health` answers on a port, or null if nothing is listening there.
 *
 * The body is read and discarded on purpose. `fetch` leaves an unread response body holding its
 * socket open in undici's pool, and this is called every 200ms during a boot — a worker that has
 * finished its specs should not still be waiting on keep-alive sockets to time out.
 */
async function probeHealth(port: number): Promise<number | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    await response.text();
    return response.status;
  } catch {
    // Nothing is listening: `fetch` rejects on ECONNREFUSED rather than resolving with a status.
    return null;
  }
}

/**
 * Boot `packages/server/dist/index.js` against `dataDir` and resolve once `/api/health` answers.
 *
 * The entrypoint is the real one, unmodified: it migrates, runs `importSeedIfEmpty`, rebuilds the
 * browse projection and listens — which is the whole point, because the seed import only ever runs
 * from there. `CRAWL_ENABLED=false` keeps the nightly scheduler out of it, so nothing in this
 * harness reaches a third-party site.
 */
export async function bootShippedServer(options: {
  port: number;
  dataDir: string;
}): Promise<BootedServer> {
  if (!existsSync(SERVER_ENTRY) || !existsSync(WEB_INDEX)) {
    throw new Error(
      `${SERVER_ENTRY} or ${WEB_INDEX} is missing, so there is nothing to boot. The default ` +
        'webServer command in playwright.config.ts runs `npm run build` before any spec starts; ' +
        'run `npm run build` first if you are driving this harness by hand.',
    );
  }

  // REFUSE A PORT SOMEBODY ELSE IS ON, and this is not defensive padding — it is the defect this
  // harness was written to catch, aimed at itself. The readiness loop below only asks whether
  // `/api/health` answers, and an orphaned server from an earlier run answers it in 40ms with a
  // corpus and a users table of its own. The first version of this file did exactly that: it
  // "booted" in 51ms, read a bootstrap token out of ITS OWN child's log, and spent it against a
  // stranger's process, which answered 401. A test suite that measures the wrong server is worse
  // than one that fails to start, so this fails to start.
  const squatter = await probeHealth(options.port);
  if (squatter !== null) {
    throw new Error(
      `something is already answering /api/health on port ${options.port} (${squatter}). ` +
        'This harness must talk to the server it started, so it will not share the port. An ' +
        'orphaned `node packages/server/dist/index.js` from an interrupted run is the usual cause.',
    );
  }

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(options.port),
      // The server opens `${DATA_DIR}/grantspotter.sqlite`. There is no DB-path env var.
      DATA_DIR: options.dataDir,
      SESSION_SECRET: 'e2e-shipped-session-secret-not-a-real-secret',
      CONTACT_URL: 'https://example.com/grantspotter',
      CRAWL_ENABLED: 'false',
    },
  });

  let output = '';
  let exitLine: string | undefined;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  // Both streams into one buffer, in arrival order: `[seed] …` goes to stdout and a config
  // refusal goes to stderr, and a harness that captured only stdout would report "timed out
  // waiting for /api/health" for a server that had already said exactly why it would not start.
  child.stdout.on('data', (chunk: string) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    output += chunk;
  });
  child.on('exit', (code, signal) => {
    exitLine = `exited with code ${String(code)} / signal ${String(signal)}`;
  });

  const server: BootedServer = {
    output: () => output,
    stop: async () => {
      if (exitLine !== undefined) return;
      child.kill('SIGTERM');
      const deadline = Date.now() + 10_000;
      while (exitLine === undefined && Date.now() < deadline) await sleep(50);
      // The entrypoint's own SIGTERM handler drains connections and checkpoints the WAL before it
      // exits; SIGKILL is the fallback that keeps a hung request from wedging the whole run, and
      // it is the way to leave a WAL-mode database mid-write, so it is never the first move.
      if (exitLine === undefined) child.kill('SIGKILL');
    },
  };

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exitLine !== undefined) {
      throw new Error(`the server on port ${options.port} ${exitLine} before it listened:\n${output}`);
    }
    if ((await probeHealth(options.port)) === 200) return server;
    await sleep(200);
  }

  await server.stop();
  throw new Error(
    `the server on port ${options.port} did not answer /api/health within ${READY_TIMEOUT_MS}ms:\n${output}`,
  );
}

/**
 * The one-time admin token out of a boot log, once the banner has actually been written.
 *
 * It is printed before `app.listen`, so it is always in the buffer by the time `/api/health`
 * answers — but stdout is a pipe and the read is asynchronous, so this polls for a moment rather
 * than reading once and blaming the server for a chunk that had not arrived.
 */
export async function bootstrapTokenFrom(server: BootedServer): Promise<string> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const match = /GrantSpotter first-run setup[\s\S]*?\n\s+([0-9a-f]{40,})\s*\n/.exec(
      server.output(),
    );
    if (match?.[1] !== undefined) return match[1];
    if (Date.now() >= deadline) {
      throw new Error(
        'no first-run bootstrap token in the boot log. The banner is printed only while the ' +
          `users table is empty, so a DATA_DIR that was not wiped is the usual cause:\n${server.output()}`,
      );
    }
    await sleep(100);
  }
}

/**
 * Spend the token. This one exchange is what creates the first account on a fresh install,
 * whether a `curl` or the first-run screen performs it; there is no other route in.
 */
export async function bootstrapAdmin(baseUrl: string, token: string): Promise<void> {
  const response = await fetch(`${baseUrl}/api/auth/bootstrap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token,
      email: OPERATOR_EMAIL,
      password: OPERATOR_PASSWORD,
      displayName: 'E2E Operator',
    }),
  });
  if (response.status !== 201) {
    throw new Error(
      `POST /api/auth/bootstrap answered ${response.status}, not 201: ${await response.text()}`,
    );
  }
}

function readShippedDb<T>(read: (db: Database.Database) => T): T {
  // Read-only, and opened per call: the server process owns this file and is still writing to it.
  const db = new Database(SHIPPED_DB_PATH, { readonly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

/** What the fresh install actually stores. Counted in the database, never restated from a plan. */
export function shippedCorpusCounts(): {
  programs: number;
  suppressed: number;
  funders: number;
  withCrawlerIdentity: number;
} {
  return readShippedDb((db) => ({
    programs: (db.prepare('SELECT COUNT(*) AS n FROM programs').get() as { n: number }).n,
    suppressed: (
      db
        .prepare("SELECT COUNT(*) AS n FROM programs WHERE tags LIKE '%do_not_publish%'")
        .get() as { n: number }
    ).n,
    funders: (db.prepare('SELECT COUNT(*) AS n FROM funders').get() as { n: number }).n,
    withCrawlerIdentity: (
      db.prepare('SELECT COUNT(*) AS n FROM programs WHERE source_id IS NOT NULL').get() as {
        n: number;
      }
    ).n,
  }));
}

/**
 * Every row storing a programme under this exact name, with the crawler identity beside it.
 *
 * The shape is deliberately a LIST rather than a count: a duplicated import is two rows with the
 * same name and different ids, and the failure message should print both of them rather than say
 * "expected 1, got 2".
 */
export function shippedProgramRowsNamed(
  name: string,
): Array<{ id: string; sourceId: string | null; externalKey: string | null }> {
  return readShippedDb((db) =>
    (
      db
        .prepare('SELECT id, source_id, external_key FROM programs WHERE name = ? ORDER BY id')
        .all(name) as Array<{ id: string; source_id: string | null; external_key: string | null }>
    ).map((row) => ({ id: row.id, sourceId: row.source_id, externalKey: row.external_key })),
  );
}
