import {
  CHOSEN_CODE_MAX_INPUT,
  describeEnrollmentCodeFold,
  normalizeEnrollmentCode,
  type EnrollmentCode,
} from '@grantspotter/core';
import { Router, type Request } from 'express';
import { z } from 'zod';
import {
  isEnvCodeLabel,
  MAX_EXPIRY_DAYS,
  MAX_USES_CEILING,
  refuseChosenCode,
  RESERVED_LABEL_REFUSAL,
} from '../auth/chosenCode.js';
import { appendAuditLog } from '../db/repositories/ingestion.js';
import { createEnrollmentCodeRepo } from '../db/repositories/enrollmentCodes.js';
import type { RouterDeps } from './deps.js';
import { AppError } from './errors.js';

/**
 * The email check this file used to declare a second copy of is now `EMAIL_SHAPE`, exported from
 * `api/adminUsersRouter.ts` — the older of the two routes that create user rows — and imported by
 * `api/auth.ts`. Nothing in this file ever used it: it was declared here only because the route
 * that needed it could not reach the original. Deleted on 2026-08-05 with the copy's own comment
 * as the instruction.
 */

/**
 * THE RULES AND THE SENTENCES THAT REFUSE A CHOSEN CODE NOW LIVE IN `auth/chosenCode.ts`.
 *
 * They were written here, and they moved on 2026-08-10 for the reason that module opens with: an
 * operator can set `ENROLLMENT_CODE` in `docker-compose.yml`, so this router is no longer the only
 * thing that can be handed a code a person chose. A code from a file is a chosen code with a YAML
 * file around it and is held to the same floor, the same ceilings and the same objection to a label
 * that gives the code away. `MAX_USES_CEILING` and `MAX_EXPIRY_DAYS` — the GENERATED path's bounds,
 * which the request schema below needs before it knows which kind of code it is being asked for —
 * moved with them so that one file holds every number in this decision.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const createBodySchema = z.object({
  label: z.string().trim().min(1).max(120),
  /**
   * THE CODE AN ADMINISTRATOR TYPED, OR NOTHING AT ALL.
   *
   * Absent or null means "generate one", which is what every caller meant before this field
   * existed and is still the default the console offers. A string means the administrator wants
   * `W1MX-FALL-2026` instead of `K7QF2-9XMPT-3RJVH-8WCND`, and everything below is about the fact
   * that those two are not the same kind of object.
   *
   * BOUNDED HERE ONLY BY LENGTH, and only at the top. The floor is not in the schema, because a
   * zod failure produces the generic "The enrollment code is invalid." and the whole point of the
   * floor is the sentence that explains the number. `CHOSEN_CODE_MAX_INPUT` is a paste guard and
   * has a different job, so it is fine for it to be a plain 422.
   *
   * `.trim()` and not more: leading and trailing whitespace is a copy-paste artefact, and
   * everything else a person can put in a code — dashes, spaces, lower case, an `O` for a `0` —
   * is handled by `normalizeEnrollmentCode`, which is the only reading of a code this product has.
   */
  code: z.string().trim().min(1).max(CHOSEN_CODE_MAX_INPUT).nullable().optional(),
  // `.nullable().optional()`: an omitted field and an explicit null both mean "no limit", because a
  // form that clears a number input sends null and a client that never offered the field sends
  // nothing, and both of those people mean the same thing.
  maxUses: z.number().int().positive().max(MAX_USES_CEILING).nullable().optional(),
  expiresInDays: z.number().int().positive().max(MAX_EXPIRY_DAYS).nullable().optional(),
});

/**
 * HOW LONG ONE ADMINISTRATOR'S PROBE AT ONE CODE GOES UNRECORDED, and why anything is recorded at
 * all. See `announceCollision` in the router for the argument this number serves.
 */
const COLLISION_NOTICE_WINDOW_MS = 15 * 60 * 1000;

/**
 * THE ONE REFUSAL A CHOSEN CODE CAN MEET THAT IS STILL WRITTEN HERE, because it is the only one
 * that is not a rule about the code itself.
 *
 * The other five moved to `auth/chosenCode.ts` when `ENROLLMENT_CODE` gave this product a second
 * way to be handed a code somebody chose; `refuseChosenCode` is now the single answer to "may this
 * be stored?". A COLLISION is not that question. It cannot be decided without asking the database,
 * it is reported through a different status (`conflict`, not `validation_failed`), and the sentence
 * names the OTHER code — which is a thing only an administrator, looking at a screen that already
 * lists every code on the instance, is allowed to be told. `auth/envEnrollmentCode.ts` answers the
 * same event from the boot path and says something different, to a different reader, for reasons
 * set out there.
 */
function collisionRefusal(label: string | null, normalized: string): string {
  const which =
    label === null
      ? 'Another enrollment code on this instance already uses that code'
      : `“${label}” already uses that code`;
  return (
    `${which}. It does not have to be spelled the same way to BE the same: capitals, dashes and ` +
    `spaces are ignored and ${describeEnrollmentCodeFold()}, so what GrantSpotter stores for both ` +
    `is ${normalized}. Pick a different code. Revoking the other one does not free the text — the ` +
    'two would still come down to the same thing, and anyone still holding the old one could use ' +
    'the new one.'
  );
}

/**
 * THE ADMIN HALF OF ENROLMENT. It is mounted by the composition root at
 * `/api/admin/enrollment-codes`, never here — this file exports a factory and registers nothing.
 *
 * Every route is `requireAuth` + `requireAdmin`. That is not merely because issuing a credential is
 * an administrative act: `GET /` returns the label, the usage count and the issuer of every code,
 * which is precisely the "how many codes exist and who holds one" that the public redemption route
 * is built to never reveal. The guard is what keeps those two facts on opposite sides of a login.
 */
export function createEnrollmentRouter(deps: RouterDeps): Router {
  const router = Router();
  const codes = createEnrollmentCodeRepo(deps.db);

  function audit(
    req: Request,
    entry: { action: string; entityId: string; detail: Record<string, unknown> },
  ): void {
    appendAuditLog(deps.db, {
      userId: deps.currentUser(req).id,
      action: entry.action,
      entityType: 'enrollment_code',
      entityId: entry.entityId,
      // NEVER the plaintext code, and never its hash. An audit trail is read by more people, and
      // kept for longer, than anything else this router writes — `adminUsersRouter.ts` says the
      // same thing about passwords, and a code is a credential in exactly the same way.
      detail: JSON.stringify(entry.detail),
      atISO: deps.now(),
    });
  }

  /**
   * WHO HAS ALREADY BEEN TOLD THAT A PARTICULAR CODE EXISTS, so that the trail records the probe
   * without becoming the probe's own hiding place. `${actor}|${code id}` -> when.
   */
  const collisionsSeen = new Map<string, number>();

  /**
   * A REFUSED CHOSEN CODE THAT HIT AN EXISTING ONE IS WRITTEN DOWN. THE REASONING, IN FULL, BECAUSE
   * THE FIRST ANSWER TO THIS QUESTION IS THE WRONG ONE.
   *
   * THE SIGNAL IS REAL. An administrator can now type a code and be told whether it is taken, so
   * "was that accepted?" is an oracle: guess `W1MX-FALL-2026`, be refused, and you now know a live
   * code's plaintext. Against a GENERATED code it is worth nothing — the guesser is up against
   * 2^100 and the alphabet excludes the folded letters entirely — but against a CHOSEN one it is
   * worth a great deal, because the guesser is an insider who can already read the label
   * ("W1MX autumn 2026 intake") off `GET /` and needs about three tries.
   *
   * IT GRANTS NO ACCESS, AND THAT IS WHY THE ANSWER IS NOT TO HIDE IT. Only an administrator can
   * reach this route, and an administrator can already `POST /api/admin/users` to mint an account
   * of any role, list every code, and revoke any of them. Learning a member-only credential is
   * strictly less than what they hold. Refusing to say WHICH code collided would also cost the
   * honest case dearly — an officer who types the same code twice in a term deserves to be told
   * which one it clashes with — and would not close the oracle anyway, since "refused" and
   * "created" are distinguishable whatever the sentence says.
   *
   * WHAT IT DOES GRANT IS SILENCE, and that is the part worth fixing. Creating a code writes an
   * audit row and a table row; creating a user writes an audit row. A REFUSED create used to write
   * nothing at all, so an administrator could learn a colleague's chosen code and leave no mark,
   * and later enrol accounts that look like they came from that colleague's intake. This product's
   * answer to a thing that cannot be prevented is to make it loud — the guess limiter, the
   * conflict limiter and the hash-queue shed all announce themselves for exactly this reason — so
   * the probe is recorded, named against the code that was probed, so its issuer can revoke it.
   *
   * ONE ROW PER ADMINISTRATOR PER CODE PER FIFTEEN MINUTES, and never on a miss. A miss creates a
   * code, which is already loud. A hit is bounded by how many real codes exist rather than by how
   * many times somebody presses the button, so the trail cannot be flooded to bury what is in it —
   * the rule `announceOnce` in `api/auth.ts` follows, for the same reason.
   *
   * The row carries the label and NOT the code, and not its digest: it is a record that somebody
   * asked, not a copy of the answer.
   */
  function announceCollision(req: Request, conflict: { id: string; label: string }): void {
    const actor = deps.currentUser(req).id;
    const key = `${actor}|${conflict.id}`;
    const nowMs = Date.parse(deps.now());
    const last = collisionsSeen.get(key);
    if (last !== undefined && nowMs - last < COLLISION_NOTICE_WINDOW_MS) return;
    // Swept on the cold path, as `announceOnce` is: the map is read only here, so a stale entry
    // costs nothing until the moment we are already looking at it, and an unbounded map would be
    // the memory version of the unbounded trail this function exists to prevent.
    for (const [seen, at] of collisionsSeen) {
      if (nowMs - at >= COLLISION_NOTICE_WINDOW_MS) collisionsSeen.delete(seen);
    }
    collisionsSeen.set(key, nowMs);
    audit(req, {
      action: 'enrollment_code.collision',
      entityId: conflict.id,
      detail: { label: conflict.label },
    });
  }

  router.get('/', deps.requireAuth, deps.requireAdmin, (_req, res) => {
    const rows: EnrollmentCode[] = codes.list();
    res.json({ codes: rows });
  });

  router.post('/', deps.requireAuth, deps.requireAdmin, (req, res, next) => {
    try {
      const parsed = createBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(
          'validation_failed',
          'The enrollment code is invalid.',
          parsed.error.issues,
        );
      }
      const { label, maxUses, expiresInDays } = parsed.data;
      const chosen = parsed.data.code ?? null;

      // Every timestamp in this router comes from the injected clock, never Date.now() — and the
      // expiry is computed FROM that same instant so a test that pins the clock pins both ends.
      const nowISO = deps.now();
      const days = expiresInDays ?? null;

      /**
       * THE LABEL THE COMPOSE FILE'S OWN CODE ANSWERS TO IS NOT AVAILABLE HERE, AND THIS IS THE
       * ONLY RULE IN THIS ROUTER THAT APPLIES TO BOTH KINDS OF CODE.
       *
       * `auth/envEnrollmentCode.ts` recognises the row set by `ENROLLMENT_CODE` by its label and by
       * nothing else, because a digest is all the table holds and there is nothing else to
       * recognise it by. So a code issued HERE under that label would be adopted by the next boot
       * as the file's, and then withdrawn by it, because the file does not name that code. The
       * administrator would watch a code they issued switch itself off after a restart with no
       * trail but a revocation nobody performed.
       *
       * It is checked before the chosen-code rules and outside the `chosen !== null` block on
       * purpose: the hazard is in the LABEL, so it is exactly as real for a generated code.
       */
      if (isEnvCodeLabel(label)) {
        throw new AppError('validation_failed', RESERVED_LABEL_REFUSAL);
      }

      /**
       * EVERY RULE THAT APPLIES ONLY TO A CODE SOMEBODY TYPED, IN ONE CALL, BEFORE ANYTHING IS
       * WRITTEN — AND THE CALL IS THE POINT.
       *
       * This was a block of six `if`s written out here, which was right while this router was the
       * only way to hand this product a code a person chose. It is not any more: `ENROLLMENT_CODE`
       * in `docker-compose.yml` is the second, and the rules had to become a function two callers
       * share rather than a block one of them owns. See `auth/chosenCode.ts` — the order they are
       * asked in, and the reason each exists, moved with them.
       *
       * Nothing here touches the generated path (`chosen === null` skips all of it) and that is the
       * honest shape, because none of these rules is about issuing a credential in general. Each is
       * about the one property that differs: a chosen code can be guessed.
       */
      if (chosen !== null) {
        const refusal = refuseChosenCode({
          code: chosen,
          label,
          // `?? null` rather than the parsed value: the schema lets the field be omitted or
          // explicitly null, and both of those mean "no limit", which is the thing being refused.
          maxUses: maxUses ?? null,
          expiresInDays: days,
        });
        if (refusal !== null) throw new AppError('validation_failed', refusal);
      }

      const expiresAt =
        days === null ? null : new Date(Date.parse(nowISO) + days * MS_PER_DAY).toISOString();

      const issued = codes.create({
        label,
        chosen,
        maxUses: maxUses ?? null,
        expiresAt,
        createdByUserId: deps.currentUser(req).id,
        nowISO,
      });

      if (!issued.ok) {
        // A conflict on the GENERATED path would mean two twenty-character draws from a 32-symbol
        // alphabet landed on the same value, which is 2^-100 per code and is not a thing anybody
        // will see. It is answered with the same sentence rather than a special one because the
        // sentence is true either way and a branch nobody can reach is a branch nobody can check.
        if (issued.conflict !== null) announceCollision(req, issued.conflict);
        throw new AppError(
          'conflict',
          collisionRefusal(
            issued.conflict === null ? null : issued.conflict.label,
            normalizeEnrollmentCode(chosen ?? ''),
          ),
        );
      }

      const { code, plaintext, normalized } = issued;

      audit(req, {
        action: 'enrollment_code.create',
        // `chosen` as a BOOLEAN and never the code: an administrator reading this trail in a year
        // needs to know which codes were the guessable kind, and needs the trail not to be a place
        // the guessable ones are written down.
        detail: { label, chosen: code.chosen, maxUses: code.maxUses, expiresAt },
        entityId: code.id,
      });

      // The one and only time this value leaves the process. There is no route that can show it
      // again: only a keyed digest is stored, so "show it to me once more" is not a feature that was
      // left out, it is a thing this design has made impossible.
      //
      // `normalized` rides along because for a chosen code the string the administrator typed is
      // NOT the thing they committed to. `W1MX-FALL-2026` is stored as `W1MXFA112026`, and the
      // console has to show them that rather than their own typing — otherwise the fold is a
      // surprise they meet later, when somebody else's code collides with theirs.
      res.status(201).json({ code, plaintext, normalized });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/revoke', deps.requireAuth, deps.requireAdmin, (req, res, next) => {
    try {
      const existing = codes.findById(req.params.id);
      if (existing === undefined) {
        throw new AppError('not_found', `No enrollment code with id "${req.params.id}".`);
      }

      const code = codes.revoke(existing.id, deps.now());
      if (code === undefined) {
        throw new AppError('not_found', `No enrollment code with id "${req.params.id}".`);
      }

      // Revoking is idempotent (the repository's UPDATE carries `AND revoked_at IS NULL`), so a
      // second press returns the same record with the FIRST revocation's timestamp. Only the press
      // that actually changed something is written to the trail: an audit log that grows a row
      // every time somebody double-clicks is an audit log people stop reading.
      if (existing.revokedAt === null) {
        audit(req, {
          action: 'enrollment_code.revoke',
          entityId: code.id,
          detail: { label: code.label, uses: code.uses },
        });
      }

      res.json({ code });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
