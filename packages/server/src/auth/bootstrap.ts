import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, sep } from 'node:path';
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
 * A RELATIVE `DATA_DIR` IS RESOLVED, NOT REFUSED — AND THE 2026-08-11 VERSION OF THIS FUNCTION
 * REFUSED IT. It returned `null` for any name that was not already absolute, which sent the caller
 * down the "no data directory" branch and printed the 48-hex token into the log the change existed
 * to keep it out of. There is no such thing as a database with no directory just because the
 * operator wrote `DATA_DIR=data`: SQLite resolved that name against the process's cwd, created the
 * file, the WAL and the shared-memory index in a directory that demonstrably exists, and this
 * function can resolve it against the same cwd and get the same place. MEASURED 2026-08-11 by
 * booting the entrypoint with `DATA_DIR=data` from a scratch cwd: 1,454,080 bytes of
 * `grantspotter.sqlite` in `$PWD/data` (with `-wal` and `-shm` beside it for the life of the
 * process), and the code being replaced here called that directory nonexistent.
 *
 * It is not a hypothetical configuration either. `e2e/helpers.ts` sets `DATA_DIR=e2e/.tmp`, so
 * EVERY end-to-end run of this project was a run in which the token went to the log.
 *
 * HOW THE PATH IS BUILT, AND WHAT IS DELIBERATELY NOT DONE TO IT. An absolute name is passed
 * through with nothing collapsed and no `realpath`: the kernel resolved that exact byte sequence
 * when SQLite opened the database, so handing it the same prefix puts the token beside the file it
 * is derived from even when a symlink or a `..` is in it — which lexical normalisation could not
 * promise, because `a/link/..` is only `a` when `link` is a directory. A relative name is anchored
 * to `process.cwd()`, which is the same cwd SQLite resolved it against (nothing in this server
 * chdirs, and this runs during startup), so that the banner names a path an operator can paste into
 * `cat` from any directory. An absolute path is also what `chmod`, the delete on `consume` and the
 * stale-file sweep need to stay pointed at one file for the life of the process.
 *
 * `null` MEANS ONE THING AND THE CALLER SAYS SO: the database has no file anywhere, because it is
 * in memory. `db.memory` is better-sqlite3's own answer to that question and it is the whole test —
 * MEASURED against the better-sqlite3 12.11.1 this repo pins, it is `true` for `:memory:`, `true`
 * for `''` (the anonymous temporary database, whose `name` is the empty string and whose directory
 * would otherwise resolve to the cwd), `true` for a database deserialised from a Buffer (whose
 * `name` it reports as `:memory:`), and `false` for a file. A name that merely LOOKS relative is
 * not this case and no longer reaches it.
 */
export function firstRunTokenPath(db: Db): string | null {
  if (db.memory) return null;
  const dir = dirname(db.name);
  const absolute = isAbsolute(dir) ? dir : anchorToCwd(dir);
  // `dirname('/x.sqlite')` is '/', the one directory that ends in a separator.
  return absolute.endsWith(sep)
    ? `${absolute}${FIRST_RUN_TOKEN_FILE}`
    : `${absolute}${sep}${FIRST_RUN_TOKEN_FILE}`;
}

/**
 * A relative directory made absolute WITHOUT `path.join`/`path.resolve`, which normalise: see the
 * paragraph above on why nothing here may collapse a `..`. `dirname` returns '.' for a bare
 * filename, and `${cwd}/.` is correct but is a path an operator would have to squint at, so that
 * one case is spelled as the cwd itself.
 */
function anchorToCwd(dir: string): string {
  const cwd = process.cwd();
  return dir === '.' ? cwd : `${cwd}${sep}${dir}`;
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
 * as the general answer. MEASURED 2026-08-11 against the entrypoint, both ways round, because the
 * failure is not the same failure twice:
 *
 *   - directory unwritable and EMPTY — `SqliteError: unable to open database file`, `code:
 *     'SQLITE_CANTOPEN'`, thrown by `new Database` in `openDatabase` (`db/migrate.ts:20`);
 *   - directory unwritable with a database ALREADY IN IT — `SqliteError: attempt to write a
 *     readonly database`, `code: 'SQLITE_READONLY_DIRECTORY'`, thrown three lines later by
 *     `db.pragma('journal_mode = WAL')`, because WAL is a second and a third file SQLite has to
 *     create beside the first.
 *
 * Both exit(1) before `createBootstrapState` is ever called. (The earlier version of this comment
 * named only the second code, which is what a single measurement of a single starting state gets
 * you.) What is left for this branch is the narrower set where the directory takes a database but
 * not this file. MEASURED in the same session, with a directory occupying the token's name: the
 * banner below printed, naming `EISDIR (is a directory)`, `grep -cE '[0-9a-f]{40,}'` counted one
 * line on stdout and none on stderr, no file was left anywhere, and `POST /api/auth/bootstrap`
 * with the token scraped out of that log answered 201 — which is the only thing that makes
 * printing it worth doing.
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
      /**
       * THE ONE CASE THAT REALLY HAS NOWHERE TO WRITE, AND THE ONLY CASE THIS BRANCH NOW CLAIMS.
       *
       * `firstRunTokenPath` returns null for an in-memory database and for nothing else, so this
       * message is true whenever it prints. It was not before: it printed for a relative `DATA_DIR`
       * as well, telling an operator that a server with a 1.4 MB database, a WAL and an shm file on
       * disk had no data directory — a wrong diagnosis, next to the secret it had just failed to
       * protect, sending them to look for a problem that was not there.
       *
       * NO CALLER IN THIS REPOSITORY REACHES IT TODAY, and it is kept and tested anyway.
       * `index.ts` opens a file under `config.dataDir`, `createTestDb` opens one under `mkdtemp`,
       * and `createBootstrapState` is called with nothing else — but `app.ts` builds a bootstrap
       * state from whatever database `createApp` is handed whenever `deps.bootstrap` is absent, and
       * this repository opens `:memory:` in twenty-odd test files. One migrated `:memory:` database
       * passed to `createApp` is all it takes; `bootstrap.test.ts` does exactly that, so the branch
       * is exercised and the sentence below is checked rather than assumed. Printing is the only
       * way the token could be reached from a database that will not outlive the process.
       */
      log(
        firstRunFallbackBanner(
          token,
          'this database is in memory, so there is no directory to put the file in',
        ),
      );
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
