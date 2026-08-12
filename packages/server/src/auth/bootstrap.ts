import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { Db } from '../db/migrate.js';

export interface BootstrapState {
  /** True while no account exists. Recomputed from the database on each call. */
  required(): boolean;
  /** The one-time token, or null once an account exists. */
  token(): string | null;
  /** Timing-safe comparison; clears the token on success. */
  consume(candidate: string): boolean;
}

/**
 * The name of the file the one-time token is written to, beside the database.
 *
 * Exported so a test can look for it without hard-coding the string in two places, and so an
 * operator reading this file finds the name they will see in `DATA_DIR`.
 */
export const FIRST_RUN_TOKEN_FILE = 'first-run-token.txt';

/**
 * WHERE THE TOKEN GOES, AND WHY IT IS DERIVED FROM THE DATABASE RATHER THAN CONFIGURED.
 *
 * `db.name` is the path better-sqlite3 opened, so its directory is `DATA_DIR` — the one directory
 * this deployment is guaranteed to have, the one the operator mounted, and the one that already
 * holds every password hash and session in the product. That last part is the whole argument for
 * putting a credential there: anybody who can read this file can already read `users.password_hash`
 * out of the file next to it, so the token adds NO new exposure to a reader who has the directory,
 * while removing it from `docker logs`, journald, a CI transcript and a shared scrollback — none of
 * which forget, and all of which are read by people who were never given the database.
 *
 * Deriving it also means no wiring: `index.ts` and `app.ts` call `createBootstrapState(db)` and get
 * this behaviour without either of them learning about a path, and a test that opens a database in
 * a throwaway directory gets a token file in that same throwaway directory.
 *
 * `null` for an in-memory database (`:memory:`, or a relative name), which has no data directory to
 * speak of. That is not a deployment; it is a test harness, and the caller falls back to printing.
 */
export function firstRunTokenPath(db: Db): string | null {
  const opened = db.name;
  if (opened === '' || !isAbsolute(opened)) return null;
  return join(dirname(opened), FIRST_RUN_TOKEN_FILE);
}

/**
 * The block printed to the container log on a boot with no accounts.
 *
 * IT NO LONGER CONTAINS THE TOKEN, AND THAT IS THE POINT OF THIS FILE'S 2026-08-11 CHANGE.
 * `createBootstrapState` only ever printed the token when `userCount() === 0`, so printing had
 * already stopped by the time the account existed — but `docker logs` keeps the line for the life
 * of the container, and a dead secret in a log an operator scrolls through, pastes into an issue,
 * or ships to a log aggregator is a secret that outlived every control we put on it. The token is
 * now written to a file whose permissions say who may read it, and this banner says where.
 *
 * EXPORTED so `deploy/readme.test.ts` can run the README's own log-reading command against the real
 * thing. The README used to say `grep -A4 'first-run setup'`, which was true when this array was
 * five lines long and silently stopped printing the token when three lines were added above it —
 * the failure mode of every fixed-line-count grep. The documented command brackets the banner by
 * its delimiters instead of counting. The first and last lines are those delimiters. Keep them.
 *
 * THE PARAMETER CHANGED MEANING AND NOT TYPE: it was the token and it is now the path the token is
 * at. That is deliberate — see the report accompanying this change — because `README.md` and
 * `deploy/readme.test.ts` are outside this change's territory and a signature change would have
 * broken their compile rather than their assertions, which is the harder failure to read.
 *
 * The closing lines used to say there was no open signup. That was true, was deliberate, and is now
 * false: anybody who can reach the deployment creates their own member account. What replaces it is
 * the other half of the same fact, which an operator needs at 2am more than the boast — until the
 * administrator exists, NOTHING can create an account here, so a fresh container left running on a
 * public address cannot be claimed by whoever finds it first.
 */
export function firstRunBanner(tokenPath: string): string {
  return [
    '============================================================',
    ' GrantSpotter first-run setup',
    '',
    ' No accounts exist yet. Open GrantSpotter in a browser: it',
    ' will offer to set up the first administrator and ask for',
    ' a one-time setup token.',
    '',
    ' THE TOKEN IS NOT PRINTED IN THIS LOG. It is in a file only',
    ' the user this server runs as can read:',
    '',
    `     ${tokenPath}`,
    '',
    ' Read it with `cat` (inside the container, if that is where',
    ' this is running). The file is deleted the moment the token',
    ' is spent, and a fresh one is written on every restart',
    ' until the administrator account exists.',
    '',
    ' Nobody can create any account here until it does. After',
    ' that, anybody who can reach this deployment can create a',
    ' member account of their own.',
    '============================================================',
  ].join('\n');
}

/**
 * WHAT IS PRINTED WHEN THE FILE COULD NOT BE WRITTEN, AND WHY THIS PRINTS THE TOKEN ANYWAY.
 *
 * A full disk, a name already taken by a directory, a per-file permission — none of them the
 * operator's fault, and all of them fatal to setup if the token exists only in a file that does
 * not exist. The alternatives were to refuse to start (a deployment that will not boot because it
 * could not write a hint file) or to say nothing (a first-run screen asking for a token nobody can
 * obtain, with the reason nowhere). Both are worse than one line in a log that says exactly what
 * happened and what it costs.
 *
 * A WHOLLY READ-ONLY `DATA_DIR` IS NOT ONE OF THE CASES, which is worth knowing before reading this
 * as the general answer. MEASURED 2026-08-11 against the built server with the data directory
 * chmod'ed unwritable: the process exits at `openDatabase` with `SQLITE_READONLY_DIRECTORY` long
 * before any of this runs, because SQLite cannot create its own WAL. What is left for this branch
 * is the narrower set where the directory takes a database but not this file. MEASURED in the same
 * session, with a directory occupying the token's name: the banner below printed, naming EISDIR,
 * and the deployment was still set up from the token in it.
 *
 * It is shouted rather than mentioned, and it names the remedy, because the operator is the only
 * person who can decide whether that log is somewhere a secret may sit.
 */
export function firstRunFallbackBanner(token: string, why: string): string {
  return [
    '============================================================',
    ' GrantSpotter first-run setup',
    '',
    ' The one-time setup token could NOT be written to a file:',
    `   ${why}`,
    '',
    ' So it is printed here instead, because the alternative is',
    ' a deployment nobody can set up. IT WILL STAY IN THIS LOG:',
    ' fix the data directory and restart to get a token that',
    ' does not, or clear the log once setup is finished.',
    '',
    `     ${token}`,
    '',
    ' A fresh token is issued on every restart until the',
    ' administrator account exists. Nobody can create any',
    ' account here until it does.',
    '============================================================',
  ].join('\n');
}

export function createBootstrapState(
  db: Db,
  log: (line: string) => void = (line) => console.log(line),
): BootstrapState {
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM users');
  const userCount = (): number => (countStmt.get() as { n: number }).n;
  const tokenPath = firstRunTokenPath(db);

  /**
   * Best-effort, and silent when it fails: this runs on the ordinary path (every boot of a
   * deployment that HAS an administrator) where there is usually nothing to delete, and a missing
   * file is the state we want. `force` covers exactly that case; a permission error here would
   * mean the write below is going to fail too, and that one is reported.
   */
  function removeTokenFile(): void {
    if (tokenPath === null) return;
    try {
      rmSync(tokenPath, { force: true });
    } catch {
      // Nothing to do and nothing to say: see above.
    }
  }

  let token: string | null = null;
  if (userCount() === 0) {
    token = randomBytes(24).toString('hex');
    let written: string | null = null;
    if (tokenPath !== null) {
      try {
        // Removed first, then created, so the mode applies. `writeFileSync`'s `mode` is only
        // honoured when it CREATES the file; overwriting an existing one keeps whatever mode it
        // already had, which on a second boot would silently be whatever the last run left.
        // `chmod` afterwards as well, because the mode argument is masked by the process umask and
        // a umask of 0 would otherwise leave this world-readable.
        rmSync(tokenPath, { force: true });
        writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
        chmodSync(tokenPath, 0o600);
        written = tokenPath;
      } catch (err) {
        log(firstRunFallbackBanner(token, err instanceof Error ? err.message : String(err)));
      }
    } else {
      // No data directory at all — an in-memory database, which is a harness rather than a
      // deployment. Printing is the only way the token can be reached, and saying so is better
      // than a banner pointing at a file that was never written.
      log(firstRunFallbackBanner(token, 'this server has no data directory (in-memory database)'));
    }
    if (written !== null) log(firstRunBanner(written));
  } else {
    // A token file left behind by an earlier boot is a live credential for an account that now
    // exists, so it is swept on the first boot that finds the deployment claimed. `consume` deletes
    // it on the ordinary path; this is the path where the container was replaced, or the account
    // was created by something other than the token, between one boot and the next.
    removeTokenFile();
  }

  return {
    required() {
      return userCount() === 0;
    },
    token() {
      return userCount() === 0 ? token : null;
    },
    consume(candidate) {
      if (token === null || userCount() > 0) return false;
      const a = Buffer.from(candidate);
      const b = Buffer.from(token);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
      token = null;
      // The file goes with the value it held. A spent token is not a secret any more, but a file
      // called `first-run-token.txt` sitting in the data directory is indistinguishable to a reader
      // from one that still works — and its absence is how an operator can tell that setup is
      // finished without signing in.
      removeTokenFile();
      return true;
    },
  };
}
