import type { AiStance, Profile, Program } from '@grantspotter/core';
import { Router } from 'express';
import { z } from 'zod';
import { composePrompt } from '../prompts/compose.js';
import { DISCLOSURE_DEFAULT_ON, disclosureNote, disclosureSentence } from '../prompts/disclosure.js';
import { TemplateNotFoundError } from '../templates/load.js';
import type { RouterDeps } from './deps.js';
import { AppError } from './errors.js';
import { profileInput, programInput } from './writingSchemas.js';

/** The exact copy required by the contract. Asserted by an e2e test. */
export const COPY_PROMPT_LABEL = 'Copy AI Prompt — includes AI-detection avoidance';
export const COPY_PROMPT_SUBTITLE =
  'Includes: this funder’s published criteria, restrictions and obligations · their AI policy, quoted, with the source URL · your profile facts · an interview-first rule so the model asks before it drafts · the specificity ruleset (named subjects, proper nouns, figures, dates) · banned stock transitions, openers and closers · a brevity pass · a never-invent-a-citation rule';

const composeBody = z.object({
  program: programInput,
  profile: profileInput.optional(),
  templateId: z.string().max(120).optional(),
  includeDisclosure: z.boolean(),
});

const disclosureBody = z.object({
  stance: z.enum(['permitted', 'permitted_with_disclosure', 'discouraged', 'prohibited', 'unaddressed']),
  funderName: z.string().max(200),
  toolName: z.string().max(120).optional(),
  authorName: z.string().max(200).optional(),
  usage: z.enum(['drafting', 'editing', 'both']).optional(),
});

/** Both endpoints echo the caller's own profile back into the prompt, so both require a session. */
export function createPromptsRouter(deps: RouterDeps): Router {
  const router = Router();
  router.use(deps.requireAuth);

  router.post('/compose', (req, res, next) => {
    const parsed = composeBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      next(new AppError('validation_failed', 'That prompt request is not valid.', parsed.error.issues));
      return;
    }
    let prompt: string;
    try {
      prompt = composePrompt({
        program: parsed.data.program as unknown as Program,
        profile: parsed.data.profile as Profile | undefined,
        templateId: parsed.data.templateId,
        includeDisclosure: parsed.data.includeDisclosure,
      });
    } catch (err) {
      // NARROW, for the same reason the templates router narrows. `composePrompt` throws nothing
      // itself; what reaches here comes from `getTemplate(templateId)` and `loadFragment(id)`.
      // A `templateId` naming no template is the caller's mistake — 404. Everything else is a
      // shipped file that will not load, and reporting THAT as a bad request would blame the
      // applicant for a broken template or a missing prompt fragment, and hide the breakage.
      if (err instanceof TemplateNotFoundError) {
        next(new AppError('not_found', err.message));
        return;
      }
      throw err;
    }
    res.json({ prompt, label: COPY_PROMPT_LABEL, subtitle: COPY_PROMPT_SUBTITLE });
  });

  router.post('/disclosure', (req, res, next) => {
    const parsed = disclosureBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      next(new AppError('validation_failed', 'That disclosure request is not valid.', parsed.error.issues));
      return;
    }
    res.json({
      sentence: disclosureSentence(parsed.data),
      note: disclosureNote(parsed.data.stance as AiStance),
      defaultOn: DISCLOSURE_DEFAULT_ON,
    });
  });

  return router;
}
