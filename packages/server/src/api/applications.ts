import { Router } from 'express';
import { z } from 'zod';
import {
  applicationChecklist,
  applicationReadiness,
  assertApplicationSchema,
  createApplication,
  deleteApplication,
  getApplication,
  listApplications,
  resolveConfirmations,
  setFactConfirmations,
  updateApplication,
} from '../db/repositories/applications.js';
import { createProgramRepo } from '../db/repositories/programs.js';
import { isKnownSlot } from '../templates/slots.js';
import type { RouterDeps } from './deps.js';
import { AppError } from './errors.js';

const createBody = z.object({
  title: z.string().trim().min(1).max(200),
  programId: z.string().trim().min(1).max(120).optional(),
});

const patchBody = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  bodyMarkdown: z.string().max(400_000).optional(),
  answers: z.record(z.string(), z.string().max(4000)).optional(),
  includeDisclosure: z.boolean().optional(),
  /**
   * `null` detaches the draft from its opportunity. A draft legitimately exists before a programme
   * is chosen (`applications.program_id` is nullable on purpose), and without this field a draft
   * created from the Applications screen rather than from a deep link could never be attached to
   * one — so its checklist could never attribute anything to the funder's own record.
   */
  programId: z.string().trim().min(1).max(120).nullable().optional(),
});

const factsBody = z.object({
  confirmations: z.record(
    z.string(),
    z.object({
      confirmed: z.boolean(),
      note: z.string().max(2000).default(''),
      /**
       * WITHOUT THIS FIELD THE CHECKLIST QUIETLY STOPS WORKING. A fact's id is `${kind}:${start}`,
       * a POSITION, so editing `$1,450` to `$9,999` reuses it and a confirmation stored under it
       * lands on a number no human ever read. Task 14 fingerprints the value to stop that — and
       * zod STRIPS UNKNOWN KEYS, so an object schema that lists only `confirmed` and `note` drops
       * the fingerprint the UI sends and reinstates the defect in full, silently, with every test
       * still green. `resolveConfirmations` derives one when the client omits it; this is what
       * lets a client send the one it actually saw.
       */
      fingerprint: z.string().max(64).optional(),
    }),
  ),
});

const NOT_FOUND = 'No draft with that id belongs to you.';

/**
 * Every route here reads or writes one user's own prose, so every route —
 * including the reads — is behind deps.requireAuth. The caller is
 * deps.currentUser(req).id and never req.user: this router does not know how
 * Plan 1 names its middleware.
 */
export function createApplicationsRouter(deps: RouterDeps): Router {
  const { db } = deps;
  assertApplicationSchema(db);
  const programs = createProgramRepo(db);
  const router = Router();
  router.use(deps.requireAuth);

  /**
   * `applications.program_id REFERENCES programs(id)` with `foreign_keys = ON`, so an id no
   * opportunity has would abort the INSERT with a SQLITE_CONSTRAINT the error handler can only
   * render as a 500 — a typo in a deep link reported as "something went wrong on our end".
   */
  const rejectUnknownProgram = (programId: string | null | undefined): AppError | undefined =>
    typeof programId === 'string' && programs.get(programId) === undefined
      ? new AppError('validation_failed', `No opportunity has the id "${programId}".`, { programId })
      : undefined;

  router.get('/', (req, res) => {
    res.json({ applications: listApplications(db, deps.currentUser(req).id) });
  });

  router.post('/', (req, res, next) => {
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) {
      next(new AppError('validation_failed', 'That application draft is not valid.', parsed.error.issues));
      return;
    }
    const unknownProgram = rejectUnknownProgram(parsed.data.programId);
    if (unknownProgram) {
      next(unknownProgram);
      return;
    }
    res.status(201).json(
      createApplication(db, { userId: deps.currentUser(req).id, ...parsed.data }, deps.now),
    );
  });

  router.get('/:id', (req, res, next) => {
    const app = getApplication(db, req.params.id as string, deps.currentUser(req).id);
    if (!app) {
      next(new AppError('not_found', NOT_FOUND));
      return;
    }
    res.json(app);
  });

  router.patch('/:id', (req, res, next) => {
    const parsed = patchBody.safeParse(req.body);
    if (!parsed.success) {
      next(new AppError('validation_failed', 'That patch is not valid.', parsed.error.issues));
      return;
    }
    for (const key of Object.keys(parsed.data.answers ?? {})) {
      if (!isKnownSlot(key)) {
        next(new AppError('validation_failed', `unknown slot "${key}"`, { slot: key }));
        return;
      }
    }
    const unknownProgram = rejectUnknownProgram(parsed.data.programId);
    if (unknownProgram) {
      next(unknownProgram);
      return;
    }
    const updated = updateApplication(
      db,
      req.params.id as string,
      deps.currentUser(req).id,
      parsed.data,
      deps.now,
    );
    if (!updated) {
      next(new AppError('not_found', NOT_FOUND));
      return;
    }
    res.json(updated);
  });

  router.get('/:id/facts', (req, res, next) => {
    const app = getApplication(db, req.params.id as string, deps.currentUser(req).id);
    if (!app) {
      next(new AppError('not_found', NOT_FOUND));
      return;
    }
    // applicationChecklist, not buildFactChecklist(body, confirmations): the third `sources`
    // argument defaults to `[]`, and without it every item reports `unattributed` and the
    // profile / program / answer distinction — the thing that makes this list reviewable rather
    // than a wall of identical checkboxes — disappears without an error.
    res.json({ items: applicationChecklist(db, app) });
  });

  router.put('/:id/facts', (req, res, next) => {
    const parsed = factsBody.safeParse(req.body);
    if (!parsed.success) {
      next(new AppError('validation_failed', 'Those fact confirmations are not valid.', parsed.error.issues));
      return;
    }
    const userId = deps.currentUser(req).id;
    const app = getApplication(db, req.params.id as string, userId);
    if (!app) {
      next(new AppError('not_found', NOT_FOUND));
      return;
    }
    const { resolved, unknownFactIds } = resolveConfirmations(app.bodyMarkdown, parsed.data.confirmations);
    if (unknownFactIds.length > 0) {
      // Storing a confirmation for an id the draft has no fact at would leave it waiting at that
      // position for whatever text lands there next — a fact pre-confirmed before it was written.
      next(
        new AppError(
          'validation_failed',
          'This draft has no fact at some of those ids — reload the checklist and confirm again.',
          { unknownFactIds },
        ),
      );
      return;
    }
    const updated = setFactConfirmations(db, app.id, userId, resolved, deps.now);
    if (!updated) {
      next(new AppError('not_found', NOT_FOUND));
      return;
    }
    res.json(applicationReadiness(db, updated));
  });

  router.get('/:id/export-readiness', (req, res, next) => {
    const app = getApplication(db, req.params.id as string, deps.currentUser(req).id);
    if (!app) {
      next(new AppError('not_found', NOT_FOUND));
      return;
    }
    res.json(applicationReadiness(db, app));
  });

  router.delete('/:id', (req, res, next) => {
    const removed = deleteApplication(db, req.params.id as string, deps.currentUser(req).id);
    if (!removed) {
      next(new AppError('not_found', NOT_FOUND));
      return;
    }
    res.status(204).end();
  });

  return router;
}
