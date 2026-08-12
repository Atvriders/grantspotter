import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createBootstrapState,
  FIRST_RUN_TOKEN_FILE,
  firstRunTokenPath,
} from './bootstrap.js';
import { migrate, openDatabase, type Db } from '../db/migrate.js';

/**
 * WHERE THE ONE-TIME SETUP TOKEN ENDS UP, FOR EVERY SHAPE OF `DATA_DIR` A DEPLOYMENT OR A TEST CAN
 * ACTUALLY BE IN.
 *
 * THIS FILE EXISTS BECAUSE THE FIX IT TESTS WAS ONE CONFIGURATION WIDE. On 2026-08-11 the token
 * stopped being printed to the boot log and started being written to a 0600 file in `DATA_DIR` —
 * the owner's explicit ask — and `firstRunTokenPath` implemented that for an ABSOLUTE `DATA_DIR`
 * only, returning null for anything else and sending the caller to a branch that prints the token
 * and blames a missing data directory. The suite went green on it, and stayed green for the same
 * reason the bug survived: every server-side harness in this repository opens its database under
 * `mkdtemp`, which is absolute, and the ONE configuration that is not — `e2e/helpers.ts`, with
 * `DATA_DIR=e2e/.tmp` — was the one whose harness scraped the token out of the log and would
 * therefore have gone red the moment the fix reached it. A test that only ever exercises the
 * configuration a fix covers cannot tell you the fix is one configuration wide.
 *
 * So the cases below are chosen by SHAPE OF PATH rather than by branch: absolute, relative, a
 * symlinked directory, a bare filename, the filesystem root, and a genuinely in-memory database.
 * Each asserts the same two things the owner asked for — no 48-hex run in anything logged, and a
 * file only the server's own user can read — or, where that is impossible, says why in words that
 * are true.
 *
 * `[0-9a-f]{40,}` is not an arbitrary regex. It is the one `e2e/shippedSeed.ts` runs over the boot
 * log to find the token, so it is exactly what "the token is in the log" means to the only other
 * reader of that log in this project.
 */

const HEX_IN_LOG = /[0-9a-f]{40,}/;
const TOKEN = /^[0-9a-f]{48}$/;

const dirs: string[] = [];
const dbs: Db[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'grantspotter-bootstrap-'));
  dirs.push(dir);
  return dir;
}

/** A migrated database at `path`, closed and cleaned up after the test. */
function migratedAt(path: string): Db {
  const db = openDatabase(path);
  migrate(db);
  dbs.push(db);
  return db;
}

/** Boots a bootstrap state against `db`, capturing everything it would have logged. */
function boot(db: Db): { token: string | null; logged: string } {
  const lines: string[] = [];
  const state = createBootstrapState(db, (line) => lines.push(line));
  return { token: state.token(), logged: lines.join('\n') };
}

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the token file, across every shape of DATA_DIR', () => {
  /**
   * THE CONFIGURATION THE FIX WAS WRITTEN FOR. Kept so the rest of the table has a control: if this
   * one ever fails, the failure is in writing files, not in resolving paths.
   */
  it('writes it beside the database when DATA_DIR is absolute', () => {
    const dir = scratch();
    const { token, logged } = boot(migratedAt(join(dir, 'grantspotter.sqlite')));

    const path = join(dir, FIRST_RUN_TOKEN_FILE);
    expect(logged).not.toMatch(HEX_IN_LOG);
    expect(logged).toContain(path);
    expect(readFileSync(path, 'utf8').trim()).toBe(token);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  /**
   * THE CONFIGURATION THE FIX MISSED, AND THE ONLY ONE THIS PROJECT'S END-TO-END SUITE HAS EVER
   * RUN IN. `process.chdir` into a throwaway directory is what makes a relative `DATA_DIR` mean
   * something, and it is exactly what `openDatabase('data/grantspotter.sqlite')` sees when
   * Playwright starts the server from the repo root with `DATA_DIR=e2e/.tmp`.
   *
   * `process.chdir` is process-wide, so it is restored in a `finally` even when an expectation
   * throws. That is enough here: vitest 3's default pool is `forks`, and test FILES inside one
   * fork run one after another rather than at the same time, so no sibling file can observe the
   * cwd this test moves. Anything that changes that (a switch to `pool: 'threads'`) makes this
   * the test to look at first.
   */
  it('resolves a relative DATA_DIR against the cwd rather than refusing it', () => {
    const dir = scratch();
    mkdirSync(join(dir, 'data'));
    const previous = process.cwd();
    try {
      process.chdir(dir);
      const db = migratedAt(join('data', 'grantspotter.sqlite'));
      // The premise: this really is the relative case, not an absolute path in disguise.
      expect(db.name).toBe(join('data', 'grantspotter.sqlite'));

      const { token, logged } = boot(db);
      const path = join(dir, 'data', FIRST_RUN_TOKEN_FILE);

      // The whole point. Before this change the token was printed here and this line was the
      // difference between the owner's ask being met and being met in one configuration.
      expect(logged).not.toMatch(HEX_IN_LOG);
      // And the banner names somewhere an operator can `cat` from any directory, not 'data/…'.
      expect(logged).toContain(path);
      expect(readFileSync(path, 'utf8').trim()).toBe(token);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      process.chdir(previous);
    }
  });

  /**
   * A BARE FILENAME — `DATA_DIR=.`, which `path.join` collapses to no directory at all before
   * SQLite ever sees it. `dirname` answers '.' and the naive `${cwd}/.` would be correct but
   * unreadable in a banner an operator is meant to copy.
   */
  it('resolves a database opened by bare filename to the cwd', () => {
    const dir = scratch();
    const previous = process.cwd();
    try {
      process.chdir(dir);
      const db = migratedAt('grantspotter.sqlite');
      expect(firstRunTokenPath(db)).toBe(join(dir, FIRST_RUN_TOKEN_FILE));
      expect(boot(db).logged).not.toMatch(HEX_IN_LOG);
    } finally {
      process.chdir(previous);
    }
  });

  /**
   * A SYMLINK IN THE PATH, which is what a `DATA_DIR` pointed at a mounted volume by a convenience
   * link looks like. The path is NOT canonicalised: the banner names the path the operator
   * configured, and the kernel resolves it to the same place it resolved the database to — which
   * is the assertion, because `readFileSync` through the link and `existsSync` on the target are
   * two different questions and both must answer yes.
   */
  it('writes through a symlinked DATA_DIR without canonicalising it away', () => {
    const dir = scratch();
    const real = join(dir, 'real');
    const link = join(dir, 'link');
    mkdirSync(real);
    symlinkSync(real, link);

    const db = migratedAt(join(link, 'grantspotter.sqlite'));
    const { token, logged } = boot(db);

    expect(logged).not.toMatch(HEX_IN_LOG);
    // Named as configured...
    expect(logged).toContain(join(link, FIRST_RUN_TOKEN_FILE));
    expect(readFileSync(join(link, FIRST_RUN_TOKEN_FILE), 'utf8').trim()).toBe(token);
    // ...and landed beside the database, on the other side of the link.
    expect(existsSync(join(real, FIRST_RUN_TOKEN_FILE))).toBe(true);
    expect(statSync(join(real, FIRST_RUN_TOKEN_FILE)).mode & 0o777).toBe(0o600);
  });

  /**
   * THE ROOT DIRECTORY IS THE ONE `dirname` ANSWER THAT ENDS IN A SEPARATOR, so a path built by
   * concatenation gets `//first-run-token.txt` unless something looks. Nothing is written here —
   * `/` is not writable and this suite does not run as root — so this asserts the string only,
   * which is the part that could be wrong.
   */
  it('does not double the separator for a database at the filesystem root', () => {
    // A stand-in for a database opened at '/grantspotter.sqlite'. `name` and `memory` are the
    // only two things `firstRunTokenPath` reads, and better-sqlite3 makes both non-configurable
    // on a real handle, so the stub is the object rather than a doctored Database — and no test
    // may write to the root of the machine it runs on to get a real one.
    const atRoot = { name: '/grantspotter.sqlite', memory: false } as unknown as Db;
    expect(firstRunTokenPath(atRoot)).toBe(`/${FIRST_RUN_TOKEN_FILE}`);
  });
});

describe('the reasons the fallback banner gives', () => {
  /**
   * THE IN-MEMORY BRANCH, AND THE REASON IT IS TESTED AT ALL.
   *
   * Its message — "this database is in memory" — used to print for a relative `DATA_DIR` too,
   * where it was false: the directory existed and held a 1.4 MB database, a `-wal` and a `-shm`.
   * A wrong reason printed beside a secret is worse than no reason, because it sends the operator
   * hunting for a problem that is not there while the token sits in their scrollback.
   *
   * NO PRODUCTION CALLER REACHES THIS. `index.ts` opens a file; every harness opens a file. It is
   * reachable through `createApp`, which builds a bootstrap state from whatever database it is
   * handed when `deps.bootstrap` is absent, and this repository opens `:memory:` in twenty-odd
   * test files. This test is that caller, so the branch is exercised and its sentence is checked.
   */
  it('says in-memory only when the database really is in memory, and prints the token there', () => {
    const db = new Database(':memory:');
    dbs.push(db);
    migrate(db);
    expect(firstRunTokenPath(db)).toBeNull();

    const { token, logged } = boot(db);
    expect(logged).toContain('could NOT be written');
    expect(logged).toContain('this database is in memory');
    // Printing IS the mitigation here: there is nowhere else the token could be read from, and a
    // first-run screen asking for a token that exists nowhere is a deployment nobody can finish.
    expect(token).toMatch(TOKEN);
    expect(logged).toContain(token);
    // And it never claims a data directory is missing, which was the false half of the old text.
    expect(logged).not.toMatch(/no data directory/i);
  });

  /**
   * THE REAL WRITE FAILURE, whose reason comes from the exception rather than from a guess: a
   * directory occupying the file's name is the same class of `writeFileSync` failure as a full
   * disk or a per-file permission. A wholly unwritable `DATA_DIR` is NOT this case — the process
   * dies in `openDatabase` (SQLITE_CANTOPEN on an empty directory, SQLITE_READONLY_DIRECTORY when
   * a database is already there) long before any of this runs; both measured 2026-08-11.
   */
  it('names the operating system error when the file cannot be written', () => {
    const dir = scratch();
    const db = migratedAt(join(dir, 'grantspotter.sqlite'));
    mkdirSync(join(dir, FIRST_RUN_TOKEN_FILE));

    const { token, logged } = boot(db);
    expect(logged).toContain('could NOT be written');
    expect(logged).toContain('EISDIR');
    expect(logged).toContain(token);
    expect(logged).toMatch(/will stay in this log/i);
  });
});
