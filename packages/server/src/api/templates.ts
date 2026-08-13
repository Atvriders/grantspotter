import type { Funder, OpportunityClass, Profile, Program } from '@grantspotter/core';
import { opportunityClassSchema } from '@grantspotter/core';
import { type NextFunction, Router } from 'express';
import { z } from 'zod';
import { pickConsortium } from '../templates/consortia.js';
import { fillTemplate } from '../templates/fill.js';
import {
  type TemplateDoc,
  TemplateNotFoundError,
  getTemplate,
  loadTemplates,
  selectTemplates,
} from '../templates/load.js';
import { SLOT_VOCABULARY, buildSlotContext, userAnswerSlots } from '../templates/slots.js';
import type { RouterDeps } from './deps.js';
import { AppError } from './errors.js';
import { answersInput, funderInput, profileInput, programInput } from './writingSchemas.js';

const summarize = (t: TemplateDoc) => ({
  id: t.id,
  title: t.title,
  layer: t.layer,
  order: t.order,
  appliesTo: t.appliesTo,
  lengthTarget: t.lengthTarget,
  requires: t.requires,
  programIds: t.programIds,
  alwaysAvailable: t.alwaysAvailable,
  sources: t.sources,
  slots: t.slots,
});

const fillBody = z.object({
  profile: profileInput.optional(),
  program: programInput.optional(),
  funder: funderInput.optional(),
  answers: answersInput.optional(),
});

/** Test seam only. Production calls `createTemplatesRouter(routerDeps)` and reads `content/`. */
export interface TemplatesRouterOptions {
  templatesRoot?: string;
}

/**
 * ONE broken file must not read as an empty library.
 *
 * `getTemplate` loads the WHOLE library to answer for a single id, so the obvious
 * `try { getTemplate(id) } catch { 404 }` reports "unknown template" for every id in the corpus
 * the moment one file on disk is malformed — the writing desk disappears and the error blames the
 * applicant's request. Only `TemplateNotFoundError` is a 404. A `TemplateError` is rethrown so it
 * reaches Plan 1's error handler as a 500, which is what a shipped template that will not load
 * actually is: broken, and someone's to fix.
 *
 * This matters more than it looks, because the loader's throws are the feature. Task 1 made it
 * throw on a missing `appliesTo` (which used to widen a restricted component to all four
 * opportunity classes), on a quoted `alwaysAvailable: "true"` (which read as false and hid the
 * Campus SGA playbook), and on a scalar `programIds` (which produced zero overlays in silence).
 * Swallowing those into a 404 restores every one of them.
 */
function templateOrNext(id: string, root: string | undefined, next: NextFunction): TemplateDoc | undefined {
  try {
    return getTemplate(id, root);
  } catch (err) {
    if (err instanceof TemplateNotFoundError) {
      next(new AppError('not_found', err.message));
      return undefined;
    }
    throw err;
  }
}

/**
 * The four GETs are public: the template library is published guidance, not
 * user data. POST /:id/fill carries the caller's own profile and answers, so it
 * is behind deps.requireAuth.
 */
export function createTemplatesRouter(
  deps: RouterDeps,
  options: TemplatesRouterOptions = {},
): Router {
  const router = Router();
  const root = options.templatesRoot;

  router.get('/', (req, res, next) => {
    // An unrecognised klass is REFUSED, not ignored. `selectTemplates` keeps the components whose
    // `appliesTo` contains the klass, so `?klass=ham_grantz` returns the few with an empty
    // `appliesTo` and looks like a short library rather than like a mistake — the same
    // silence-as-assertion the loader closed one layer down.
    const rawKlass = req.query.klass;
    if (rawKlass !== undefined && !opportunityClassSchema.safeParse(rawKlass).success) {
      next(
        new AppError(
          'validation_failed',
          `Unknown opportunity class "${String(rawKlass)}" in "klass". Expected one of ${opportunityClassSchema.options.join(', ')}.`,
        ),
      );
      return;
    }
    const klass = rawKlass === undefined ? undefined : (rawKlass as OpportunityClass);
    const programId = typeof req.query.programId === 'string' ? req.query.programId : undefined;
    const funderId = typeof req.query.funderId === 'string' ? req.query.funderId : undefined;
    const selection = selectTemplates(loadTemplates(root), { klass, programId, funderId });
    res.json({
      components: selection.components.map(summarize),
      overlays: selection.overlays.map(summarize),
      playbooks: selection.playbooks.map(summarize),
      // What the library holds, which no query narrows — see `TemplateSelection.libraryOverlays`.
      // `overlays` stays the funder-bound answer, empty when no funder was named, because the
      // writing desk reads `overlays[0]` as "this applicant's funder overlay" and inserting
      // another funder's criteria from that position would be a fabricated requirement.
      libraryOverlays: selection.libraryOverlays.map(summarize),
    });
  });

  // Registered before /:id, or Express matches "slots" as a template id.
  router.get('/slots', (_req, res) => {
    res.json({ all: SLOT_VOCABULARY, userAnswerable: userAnswerSlots() });
  });

  router.get('/consortium/:state', (req, res, next) => {
    const consortium = pickConsortium(req.params.state as string);
    if (!consortium) {
      next(new AppError('not_found', 'No Space Grant consortium for that state code.'));
      return;
    }
    res.json({ consortium });
  });

  router.get('/:id', (req, res, next) => {
    const t = templateOrNext(req.params.id as string, root, next);
    if (!t) return;
    res.json({ ...summarize(t), body: t.body });
  });

  router.post('/:id/fill', deps.requireAuth, (req, res, next) => {
    const parsed = fillBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      next(new AppError('validation_failed', 'That fill request is not valid.', parsed.error.issues));
      return;
    }
    const template = templateOrNext(req.params.id as string, root, next);
    if (!template) return;
    const ctx = buildSlotContext({
      profile: parsed.data.profile as Profile | undefined,
      program: parsed.data.program as Program | undefined,
      funder: parsed.data.funder as Funder | undefined,
      answers: parsed.data.answers,
    });
    res.json({ templateId: template.id, title: template.title, ...fillTemplate(template.body, ctx) });
  });

  return router;
}
