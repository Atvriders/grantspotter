import type { Funder, Profile, Program } from '@grantspotter/core';
import { Router } from 'express';
import { buildFactChecklist, factSourcesFromKnowledge } from '../prose/facts.js';
import { analyzeProse, paragraphDensities } from '../prose/index.js';
import { renderSlotValue } from '../templates/fill.js';
import { describeSlotKnowledge } from '../templates/slots.js';
import type { RouterDeps } from './deps.js';
import { AppError } from './errors.js';
import { factsInput, textInput } from './writingSchemas.js';

const TEXT_REQUIRED = 'A non-empty "text" field is required.';

/**
 * Both endpoints carry the caller's own draft prose, so both require a session.
 *
 * Neither one rewrites the applicant's text and neither claims to defeat a detector. The report
 * surfaces where a passage reads generic and why — style-word density without referential
 * counterweight — so the applicant can replace vagueness with specifics they actually know. A
 * human writing in a hurry produces the same signal, and nothing here may imply otherwise.
 */
export function createProseRouter(deps: RouterDeps): Router {
  const router = Router();
  router.use(deps.requireAuth);

  router.post('/analyze', (req, res, next) => {
    const parsed = textInput.safeParse(req.body ?? {});
    if (!parsed.success) {
      next(new AppError('validation_failed', TEXT_REQUIRED, parsed.error.issues));
      return;
    }
    const report = analyzeProse(parsed.data.text);
    res.json({
      report,
      densities: report.paragraphs.map((p) => ({ index: p.index, ...paragraphDensities(p) })),
    });
  });

  router.post('/facts', (req, res, next) => {
    const parsed = factsInput.safeParse(req.body ?? {});
    if (!parsed.success) {
      next(new AppError('validation_failed', TEXT_REQUIRED, parsed.error.issues));
      return;
    }
    // The third argument is what makes the checklist reviewable. Without it every item reports
    // `unattributed` and "the funder published this" stops reading differently from "I typed
    // this" — no error, no warning, just a wall of identical checkboxes. `renderSlotValue` is
    // injected so attribution cannot drift from how the value was rendered into the document.
    const sources = factSourcesFromKnowledge(
      describeSlotKnowledge({
        profile: parsed.data.profile as Profile | undefined,
        program: parsed.data.program as Program | undefined,
        funder: parsed.data.funder as Funder | undefined,
        answers: parsed.data.answers,
      }),
      renderSlotValue,
    );
    // No confirmations are read or written here: this router is stateless, and a stored
    // confirmation belongs to an application draft (the applications router owns it). Every item
    // therefore comes back unconfirmed, including a `program`-origin one — origin is who said it,
    // never whether a human has checked it.
    res.json({ items: buildFactChecklist(parsed.data.text, {}, sources) });
  });

  return router;
}
