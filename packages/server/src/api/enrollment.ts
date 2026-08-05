import type { EnrollmentCode } from '@grantspotter/core';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { appendAuditLog } from '../db/repositories/ingestion.js';
import { createEnrollmentCodeRepo } from '../db/repositories/enrollmentCodes.js';
import type { RouterDeps } from './deps.js';
import { AppError } from './errors.js';

/**
 * A deliberately conservative email check, and A SECOND COPY OF ONE THIS REPOSITORY ALREADY HAS.
 *
 * `api/adminUsersRouter.ts` declares the identical pattern, with the identical reasoning: the real
 * gate is the unique index on `users.email_normalized`, and this only rejects input that could
 * never be an address, so a typo produces 422 rather than a permanently unusable account. That one
 * is not exported and that file is outside this change's territory, so the choice was to duplicate
 * eleven characters or to let a self-service sign-up form accept `not-an-address` and hand somebody
 * an account they can never receive a password reset for.
 *
 * IT IS EXPORTED so that the enrolment route in `api/auth.ts` uses this one rather than minting a
 * third. Two copies is a reported defect, not a design: the pair should become one exported
 * constant the moment `adminUsersRouter.ts` can be edited.
 */
export const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The upper bounds on a code, and neither is arbitrary.
 *
 * `maxUses` at 10,000: a club intake is tens and a conference badge run is hundreds, so anything
 * past this is a typo (a missing decimal point, a pasted phone number) and a typo that mints a
 * practically unlimited credential should be refused rather than honoured. An admin who genuinely
 * wants no limit says so explicitly with `null`, which is a different and visible decision.
 *
 * `expiresInDays` at 3,650: ten years is longer than any intake and shorter than forever, and
 * `null` again says forever explicitly.
 */
const MAX_USES_CEILING = 10_000;
const MAX_EXPIRY_DAYS = 3650;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const createBodySchema = z.object({
  label: z.string().trim().min(1).max(120),
  // `.nullable().optional()`: an omitted field and an explicit null both mean "no limit", because a
  // form that clears a number input sends null and a client that never offered the field sends
  // nothing, and both of those people mean the same thing.
  maxUses: z.number().int().positive().max(MAX_USES_CEILING).nullable().optional(),
  expiresInDays: z.number().int().positive().max(MAX_EXPIRY_DAYS).nullable().optional(),
});

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

      // Every timestamp in this router comes from the injected clock, never Date.now() — and the
      // expiry is computed FROM that same instant so a test that pins the clock pins both ends.
      const nowISO = deps.now();
      const days = expiresInDays ?? null;
      const expiresAt =
        days === null ? null : new Date(Date.parse(nowISO) + days * MS_PER_DAY).toISOString();

      const { code, plaintext } = codes.create({
        label,
        maxUses: maxUses ?? null,
        expiresAt,
        createdByUserId: deps.currentUser(req).id,
        nowISO,
      });

      audit(req, {
        action: 'enrollment_code.create',
        entityId: code.id,
        detail: { label, maxUses: code.maxUses, expiresAt },
      });

      // The one and only time this value leaves the process. There is no route that can show it
      // again: only its SHA-256 is stored, so "show it to me once more" is not a feature that was
      // left out, it is a thing this design has made impossible.
      res.status(201).json({ code, plaintext });
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
