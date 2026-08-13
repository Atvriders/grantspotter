import type { AiStance, Profile, Program } from '@grantspotter/core';
import { Router } from 'express';
import { z } from 'zod';
import { type PromptContents, composePromptContents } from '../prompts/compose.js';
import { DISCLOSURE_DEFAULT_ON, disclosureNote, disclosureSentence } from '../prompts/disclosure.js';
import { TemplateNotFoundError } from '../templates/load.js';
import type { RouterDeps } from './deps.js';
import { AppError } from './errors.js';
import { profileInput, programInput } from './writingSchemas.js';

/** The exact copy required by the contract. Asserted by an e2e test. */
export const COPY_PROMPT_LABEL = 'Copy AI Prompt — includes AI-detection avoidance';

/**
 * The enumeration spec §10.2 requires, printed BEFORE anything is composed — so every clause in it
 * has to be true of every prompt this endpoint can produce.
 *
 * Two of them were not. "their AI policy, quoted, with the source URL" is a description of a page
 * 142 of the 143 shipped records have never published, and "your profile facts" was recited to
 * readers with no profile: measured on the live site on 2026-08-13, a member who had saved nothing
 * copied 21,145 characters containing no "## Facts about me that you may use" section at all. Both
 * are now stated as the conditions they are, and the exact contents of the copied brief come back
 * from `composePromptContents` in `included` / `omitted`, built at the same `if` that writes each
 * section. The button prints those after the copy, so the reader learns what actually went in
 * rather than what usually does.
 */
export const COPY_PROMPT_SUBTITLE =
  'Includes: this funder’s published criteria, restrictions and obligations · their AI policy, quoted with the source URL, where they have published one · the facts on your profile, if you have saved any · an interview-first rule so the model asks before it drafts · the specificity ruleset (named subjects, proper nouns, figures, dates) · banned stock transitions, openers and closers · a brevity pass · a never-invent-a-citation rule. Copying it reports exactly which of these went in.';

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
    let composed: PromptContents;
    try {
      composed = composePromptContents({
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
    res.json({
      prompt: composed.prompt,
      label: COPY_PROMPT_LABEL,
      subtitle: COPY_PROMPT_SUBTITLE,
      // What THIS brief contains, and what it does not, from the composer itself. The screen
      // prints them after the copy; nothing here re-derives the list from the prompt text.
      included: composed.included,
      omitted: composed.omitted,
    });
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
