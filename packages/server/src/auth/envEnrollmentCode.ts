import type { EnrollmentCode } from '@grantspotter/core';
import type { Db } from '../db/migrate.js';
import { createEnrollmentCodeRepo } from '../db/repositories/enrollmentCodes.js';
import { appendAuditLog } from '../db/repositories/ingestion.js';
import { ENV_CODE_LABEL, isEnvCodeLabel, type EnvEnrollmentCode } from './chosenCode.js';

/**
 * WHAT "SET AT BOOT" MEANS FOR A ROW IN A DATABASE — WHICH IS THE WHOLE OF THIS FILE, BECAUSE A
 * LINE IN A YAML FILE AND A ROW IN A TABLE HAVE DIFFERENT LIVES AND SOMETHING HAS TO SAY HOW THEY
 * MEET.
 *
 * ------------------------------------------------------------------ the thing that is not negotiable
 *
 * THE CODE ENDS UP AS AN ORDINARY `enrollment_codes` ROW AND NOTHING ELSE, and every alternative was
 * worse in the same way. A special case checked at redemption time — "or does it match
 * `process.env.ENROLLMENT_CODE`?" — would have been ten lines, and it would have had no use count,
 * no expiry, no revocation, no audit trail and no line in the admin table: a credential with none
 * of the four bounds this product spent its whole design on, sitting beside codes that have all
 * four. Everything downstream of `redeem` therefore does not know this feature exists, which is the
 * property that makes it safe rather than the property that made it easy.
 *
 * ------------------------------------------------------------------ so what does a boot DO
 *
 * A BOOT RECONCILES, AND THE INVARIANT IT KEEPS IS ONE SENTENCE: **at most one code from the file
 * is live, and it is the one the file names right now.** Every branch below is that sentence
 * applied to a state the table can be in.
 *
 *   the file says nothing, and never did      nothing happens, and nothing is logged
 *   the file says nothing, a row is live      the row is WITHDRAWN
 *   the file names a code that does not exist any live file-row is withdrawn, and the code is created
 *   the file names the row it named last boot NOTHING HAPPENS — see below, this is the important one
 *   the file names a row that was withdrawn   it stays withdrawn; the server starts and says so
 *   the file names a code issued in the app   it is left alone, NOT adopted; the server says so
 *
 * A SECOND BOOT ON THE SAME VALUE IS A NO-OP, AND THAT IS A DECISION RATHER THAN AN OPTIMISATION.
 * The row keeps its `uses`, its `last_used_at` and — this is the one that matters — its ORIGINAL
 * EXPIRY. Recomputing `expires_at` as "now + 90 days" on every boot would mean a container that
 * restarts weekly holds a code that never expires, and the expiry is not decoration: it is the only
 * bound on a broadcast code that does not depend on somebody remembering to revoke it
 * (`CHOSEN_CODE_MAX_DAYS`). A restart must never be able to extend a credential. The cost is that
 * editing `ENROLLMENT_CODE_DAYS` or `ENROLLMENT_CODE_MAX_USES` alone does nothing until the code
 * itself changes, so the boot log prints the bounds the ROW actually carries rather than the ones
 * in the file, and says which is which.
 *
 * A CHANGED VALUE WITHDRAWS THE OLD CODE, AND DOES NOT DELETE IT. An operator who edits the line
 * did not mean "leave the old one live" — that would leave two doors open and only one of them
 * written down anywhere. Withdrawing is `revoke`, the product's existing verb: the row stays with
 * its label, its use count and its history, the audit trail gains a line, and anybody still holding
 * the old code is answered "that code has been withdrawn" rather than "not valid", which is the
 * sentence that gets them to ask somebody. Deleting the row would have destroyed exactly the
 * evidence an operator wants on the day they ask how many accounts that code made.
 *
 * A REMOVED LINE WITHDRAWS IT TOO, for the same reading of intent: somebody who deletes the line
 * and restarts means "stop letting people in with that". The alternative — leaving it live because
 * the file no longer mentions it — would make removal the one edit that does not work, and would
 * leave a live credential whose only record is in a file the operator has just emptied.
 *
 * A WITHDRAWN CODE IS NEVER BROUGHT BACK, and this is where the "reconcile" reading has to stop.
 * If an administrator revokes the file's code in the app, the next restart leaves it revoked: a
 * restart must not undo a deliberate act, and the operator did not perform the restart in order to
 * overrule their colleague. The same rule covers reverting the file to a code it used to hold, and
 * there it is doing real work rather than being consistent — bringing a retired code back re-arms
 * every copy of it that was read out, photographed and forwarded while it was live, which is
 * precisely the argument `collisionRefusal` makes to an administrator who tries it in the app. To
 * reopen the door, name a code that has not been used here before.
 *
 * ------------------------------------------------------------ why nothing here refuses to start
 *
 * `config.ts` REFUSES TO START ON A BAD VALUE AND THIS FILE NEVER DOES, and the split is exact:
 * a rule that is a pure function of the file is a CONFIGURATION ERROR, and one that depends on what
 * is in the database is a FACT ABOUT THIS DEPLOYMENT. The first can only ever fire on the boot
 * immediately after an operator edited the file, so refusing there costs a restart and lands on the
 * person who caused it. The second can fire on a boot nobody asked for: an administrator revokes
 * the code on Tuesday and the host reboots on Sunday, and a server that refused to start on that
 * would take a working grant tracker down because of an optional convenience that somebody
 * deliberately switched off. Every outcome below therefore starts the server and says what is true,
 * in a sentence that names both what is not working and what to do about it.
 *
 * -------------------------------------------------------------------------- what is never logged
 *
 * THE CODE IS NOT PRINTED, and neither is its normalised form. The operator already has the value —
 * it is in the file they just edited — so printing it buys nothing and copies a credential into
 * `docker logs`, which is the artefact people paste into forum threads and support tickets. The
 * one thing they might not know is what the fold did to their code, and they are told THAT the
 * only time it matters: `tooShortRefusal` prints the length after normalisation, and everything
 * else about the fold is transparent, because a student typing the same string they were given
 * normalises to the same digest.
 */

/** What one boot did about `ENROLLMENT_CODE`. Returned so tests can assert on it rather than on a log. */
export type EnvCodeOutcome =
  /** Nothing set, nothing left over. The overwhelmingly common case, and it logs nothing at all. */
  | { kind: 'off' }
  /** The line was removed (or emptied) and the code it used to name has been withdrawn. */
  | { kind: 'withdrawn'; withdrew: number }
  | { kind: 'created'; code: EnrollmentCode; withdrew: number }
  /** Same value as last boot. The row is untouched — see the docblock on why that includes expiry. */
  | { kind: 'unchanged'; code: EnrollmentCode }
  /** The file names a code that is revoked, expired or used up. It is not resurrected. */
  | { kind: 'closed'; code: EnrollmentCode; withdrew: number }
  /** The file names a code an administrator issued in the app. Left alone, not taken over. */
  | { kind: 'app-owned'; code: EnrollmentCode; withdrew: number }
  /** Set, but there is no administrator yet to attribute it to. Created at bootstrap instead. */
  | { kind: 'deferred'; withdrew: number }
  /** `create` refused after all the checks passed — a race, or a state this file did not foresee. */
  | { kind: 'refused'; withdrew: number };

export interface SyncEnvEnrollmentCodeInput {
  db: Db;
  /** `config.enrollmentCode` — already refused by `resolveEnrollmentCode` if it was unusable. */
  spec: EnvEnrollmentCode | undefined;
  nowISO: string;
  log?: (line: string) => void;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * WHO THE FILE'S CODE IS ATTRIBUTED TO: the oldest administrator, enabled ones first.
 *
 * `created_by_user_id` IS `NOT NULL REFERENCES users(id) ON DELETE CASCADE`, so this is not a
 * choice about tidiness — a code cannot exist without naming somebody. The honest answer is "the
 * operator, through a file", and there is no row for that. The oldest administrator is the closest
 * true statement available: on a self-hosted instance they are, with near certainty, the person who
 * wrote the compose file, and they are the one person guaranteed to be able to act on the row.
 *
 * INVENTING A SYSTEM USER WAS THE OTHER OPTION AND IS WORSE. `users` rows carry a password hash, a
 * role and an ICS token; a synthetic one would appear in the admin user list, would be a row
 * somebody could enable or reset, and would be a permanent account created as a side effect of a
 * configuration value. A false row in the users table is a heavier lie than an imprecise
 * attribution in one column.
 *
 * WHAT THE CASCADE THEN MEANS, STATED RATHER THAN DISCOVERED: delete that administrator and the
 * file's code goes with them, and the next boot creates it again — with a fresh expiry and a use
 * count back at zero. That is the schema's rule for every code and this one is not exempted from
 * it; the only difference is that this one comes back, which is the direction to be wrong in.
 *
 * `ORDER BY disabled` first: a disabled administrator can still own a row, but if there is an
 * enabled one they are the better answer, because they are the one who can revoke it.
 */
function foundingAdminId(db: Db): string | undefined {
  const row = db
    .prepare(
      `SELECT id FROM users WHERE role = 'admin' ORDER BY disabled, created_at, id LIMIT 1`,
    )
    .get() as { id: string } | undefined;
  return row?.id;
}

/**
 * RECONCILE `ENROLLMENT_CODE` AGAINST THE TABLE. Never throws, never refuses to start, always says
 * what it did.
 *
 * CALLED FROM TWO PLACES AND THE SECOND ONE IS NOT AN AFTERTHOUGHT. `index.ts` calls it at boot.
 * `api/auth.ts` calls it again the moment the first administrator is created, because on a fresh
 * database there is nobody to attribute a code to and the boot call can only defer. Without the
 * second call an operator who set the code and deployed for the first time would have to restart
 * the container after finishing setup, with no symptom but a code that does not work.
 *
 * THAT DEFERRAL IS A SECURITY PROPERTY AND NOT ONLY A FOREIGN KEY. The README's promise is that the
 * first administrator always comes out of the container log and that nothing self-serve exists
 * until an administrator has acted. A compose file that minted a live account-creating credential
 * against an empty database would break exactly that: anybody who reached the instance between
 * `docker compose up` and the operator finishing the first-run screen could enrol. The schema
 * happened to force the right answer, and this comment is here so a later change that relaxes the
 * foreign key does not quietly take it away.
 */
export function syncEnvEnrollmentCode(input: SyncEnvEnrollmentCodeInput): EnvCodeOutcome {
  const { db, spec, nowISO } = input;
  const log = input.log ?? ((line: string) => console.log(line));
  const codes = createEnrollmentCodeRepo(db);

  // The row the file names right now, in whatever state, or undefined if this deployment has never
  // seen this code. `findByCode` and not `inspect`: a revoked row has to be found, not hidden.
  const named = spec === undefined ? undefined : codes.findByCode(spec.code);
  const keepId = named !== undefined && isEnvCodeLabel(named.label) ? named.id : null;

  /**
   * THE INVARIANT, APPLIED FIRST AND BEFORE ANYTHING IS CREATED: no code from the file stays live
   * unless the file still names it.
   *
   * WITHDRAWING BEFORE CREATING RATHER THAN AFTER, and the ordering is chosen for the crash. If the
   * process dies between the two statements, this order leaves NO file-set code live and the next
   * boot creates the new one; the other order would leave the old code live indefinitely with
   * nothing in the file pointing at it. Nothing is listening yet either way — `app.listen` is the
   * last thing `main` does — so there is no window a request can see.
   *
   * NOT ONE TRANSACTION AROUND BOTH: `create` takes the write lock with `.immediate()` of its own,
   * and the failure this would protect against is already handled by being idempotent on the next
   * boot. A savepoint here would buy atomicity against a crash whose only cost is a restart.
   */
  let withdrew = 0;
  for (const row of codes.list()) {
    if (!isEnvCodeLabel(row.label)) continue;
    if (row.id === keepId) continue;
    if (row.revokedAt !== null) continue;
    codes.revoke(row.id, nowISO);
    withdrew += 1;
    audit(db, nowISO, {
      action: 'enrollment_code.revoke',
      entityId: row.id,
      // `via` distinguishes this from an administrator pressing the button, which is the first
      // question anybody reading this row will have: nobody was signed in when it happened.
      detail: { label: row.label, uses: row.uses, via: 'ENROLLMENT_CODE' },
    });
  }

  if (spec === undefined) {
    if (withdrew === 0) return { kind: 'off' };
    log(
      `[enrollment] ENROLLMENT_CODE is no longer set in docker-compose.yml, so the code it named ` +
        `has been withdrawn and no longer creates accounts. Anyone still holding it is told it was ` +
        `withdrawn. The row stays in Admin → Enrollment codes with its use count and its history.`,
    );
    return { kind: 'withdrawn', withdrew };
  }

  if (named !== undefined && !isEnvCodeLabel(named.label)) {
    /**
     * THE FILE NAMES A CODE SOMEBODY ISSUED IN THE APP. IT IS NOT TAKEN OVER, AND REFUSING TO START
     * WAS THE OTHER CANDIDATE.
     *
     * Refusing was rejected because the operator's goal is already met: the code they want to work
     * DOES work, it is simply governed from the admin screen instead of from the file. Taking the
     * whole deployment down to complain about a door that is open is the disproportion `config.ts`
     * argues against, and the honest half of that argument is that this outcome is not a mistake so
     * much as a duplication.
     *
     * ADOPTING IT — relabelling the row so the file owns it — was the other other candidate and is
     * the dangerous one. It would let a line in a file seize a credential an administrator issued,
     * with its own bounds and its own issuer, and then withdraw it on the next edit. A configuration
     * value must not be able to take something away from the person who created it.
     *
     * So the sentence has to say every way in which the file does NOT govern that row, because the
     * operator's reasonable assumption is that it does.
     */
    log(
      `[enrollment] ENROLLMENT_CODE names a code this instance already has: “${named.label}”, ` +
        `issued from Admin → Enrollment codes. GrantSpotter has NOT taken it over — its use limit, ` +
        `its expiry and its issuer are the ones it was created with, ENROLLMENT_CODE_MAX_USES and ` +
        `ENROLLMENT_CODE_DAYS are being ignored for it, and removing the ENROLLMENT_CODE line will ` +
        `not withdraw it. Manage it on that screen, or set ENROLLMENT_CODE to a code this instance ` +
        `has not used before.`,
    );
    return { kind: 'app-owned', code: named, withdrew };
  }

  if (named !== undefined) {
    const closed =
      named.revokedAt !== null ||
      (named.expiresAt !== null && named.expiresAt <= nowISO) ||
      (named.maxUses !== null && named.uses >= named.maxUses);
    if (!closed) {
      log(
        `[enrollment] ENROLLMENT_CODE unchanged: the code in docker-compose.yml is live, ` +
          `${String(named.uses)} of ${named.maxUses === null ? 'unlimited' : String(named.maxUses)} ` +
          `uses spent, ${named.expiresAt === null ? 'no expiry' : `expires ${named.expiresAt}`}. ` +
          `Those limits were fixed when the code was created and a restart does not extend them; ` +
          `change ENROLLMENT_CODE itself to issue a new one with new limits.`,
      );
      return { kind: 'unchanged', code: named };
    }
    // The one outcome where the operator's file and the truth disagree and the file does not win.
    // Both roads here — an administrator revoked it, or the operator reverted to a code this
    // instance has retired — end in the same place, and the same sentence is true of both.
    log(
      `[enrollment] ENROLLMENT_CODE names a code that is no longer open on this instance ` +
        `(${describeClosure(named, nowISO)}), and a restart does not bring one back: everyone who ` +
        `was given it while it was live would be let in again. It is NOT creating accounts. To ` +
        `open a new door, set ENROLLMENT_CODE to a code this instance has not used before.`,
    );
    return { kind: 'closed', code: named, withdrew };
  }

  const issuer = foundingAdminId(db);
  if (issuer === undefined) {
    log(
      `[enrollment] ENROLLMENT_CODE is set, and no administrator account exists yet. A code has to ` +
        `be attributed to somebody, and nothing self-serve may exist before an administrator does, ` +
        `so it will be created the moment you finish the first-run setup above — no restart needed.`,
    );
    return { kind: 'deferred', withdrew };
  }

  const expiresAt = new Date(Date.parse(nowISO) + spec.days * MS_PER_DAY).toISOString();
  const issued = codes.create({
    label: ENV_CODE_LABEL,
    // A chosen code, because it is one: somebody typed it. The admin table marks it Chosen, which
    // is the honest thing for it to say — this is a code a person can think of, not 2^100.
    chosen: spec.code,
    maxUses: spec.maxUses,
    expiresAt,
    createdByUserId: issuer,
    nowISO,
  });

  if (!issued.ok) {
    // Should be unreachable: `named` was undefined a few statements ago, and nothing between then
    // and here can have inserted the same digest in a single-process server. Kept for the reason
    // the repository keeps its own unreachable catch — "should be unreachable" is a claim about
    // today's callers, and the cost of being wrong is silence about a door that did not open.
    log(
      `[enrollment] ENROLLMENT_CODE could not be created: the code is already in this instance's ` +
        `table${issued.conflict === null ? '' : ` as “${issued.conflict.label}”`}. No account can ` +
        `be created with it from the file. Set ENROLLMENT_CODE to a different value.`,
    );
    return { kind: 'refused', withdrew };
  }

  audit(db, nowISO, {
    action: 'enrollment_code.create',
    entityId: issued.code.id,
    detail: {
      label: ENV_CODE_LABEL,
      chosen: true,
      maxUses: issued.code.maxUses,
      expiresAt,
      via: 'ENROLLMENT_CODE',
    },
  });

  log(
    `[enrollment] ENROLLMENT_CODE ${withdrew > 0 ? 'changed' : 'set'}: a code from ` +
      `docker-compose.yml is live for up to ${String(spec.maxUses)} accounts and expires ` +
      `${expiresAt} (${String(spec.days)} days).` +
      (withdrew > 0 ? ` The code it replaces has been withdrawn.` : '') +
      ` It is listed as “${ENV_CODE_LABEL}” in Admin → Enrollment codes, where it can be revoked. ` +
      `The code itself is not printed here — it is in your compose file, and a log is not a place ` +
      `to keep a credential.`,
  );
  return { kind: 'created', code: issued.code, withdrew };
}

/** Which of the three closures this is, for a sentence a person reads. Revocation outranks the rest. */
function describeClosure(code: EnrollmentCode, nowISO: string): string {
  if (code.revokedAt !== null) return `it was revoked on ${code.revokedAt}`;
  if (code.expiresAt !== null && code.expiresAt <= nowISO) return `it expired on ${code.expiresAt}`;
  return `it has been used all ${String(code.maxUses ?? 0)} times it was issued for`;
}

/**
 * `userId: null`, and the null is the accurate value rather than a gap.
 *
 * `appendAuditLog` made its actor nullable for the refused-enrolment row, on the ground that naming
 * any user in the one record that exists to be believed would be a false statement. This is the
 * same case one step further out: nobody was signed in, nobody pressed anything, and a boot read a
 * file. Attributing it to the administrator whose id is in `created_by_user_id` would put a
 * colleague's name against an act they did not perform.
 */
function audit(
  db: Db,
  nowISO: string,
  entry: { action: string; entityId: string; detail: Record<string, unknown> },
): void {
  appendAuditLog(db, {
    userId: null,
    action: entry.action,
    entityType: 'enrollment_code',
    entityId: entry.entityId,
    // Never the code and never its digest, exactly as `api/enrollment.ts` refuses to write them:
    // the trail is read by more people and kept for longer than anything else here.
    detail: JSON.stringify(entry.detail),
    atISO: nowISO,
  });
}
