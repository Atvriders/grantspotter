import { z } from 'zod';

/**
 * Plan-local. These validate ONLY the fields the writing tools consume, and
 * pass everything else through untouched, so they never drift from the frozen
 * core types in packages/core/src/types.ts.
 *
 * `.passthrough()` is load-bearing rather than lazy: `composePrompt` reads
 * optional members of `Program` these schemas do not name — `trust.disputed`,
 * `trust.staleMirrorWarning`, `applyContact` — and a stripping schema would
 * delete a contested-facts block or a stale-mirror warning on its way through
 * the router. Silently dropping a caveat is the failure mode this repository
 * keeps finding; it is not one to reintroduce at the edge.
 */

export const funderInput = z
  .object({ id: z.string(), name: z.string(), homepage: z.string() })
  .passthrough();

export const profileInput = z
  .object({ kind: z.enum(['student', 'organization']) })
  .passthrough();

export const programInput = z
  .object({
    id: z.string(),
    funderId: z.string(),
    name: z.string(),
    klass: z.enum(['ham_grant', 'ham_scholarship', 'adjacent_stem', 'equipment_in_kind']),
    applicantEntities: z.array(z.string()),
    amount: z.object({ amountRaw: z.string(), awardCountRaw: z.string() }).passthrough(),
    deadline: z.object({ kind: z.string(), note: z.string() }).passthrough(),
    applyVia: z.string(),
    applyUrl: z.string().optional(),
    constraints: z.array(z.object({ hard: z.boolean(), rawText: z.string() }).passthrough()),
    fundingRestrictions: z.array(z.string()),
    obligations: z.object({}).passthrough(),
    aiPolicy: z.object({ stance: z.string() }).passthrough(),
    trust: z
      .object({ status: z.string(), sourceUrl: z.string(), lastVerifiedAt: z.string() })
      .passthrough(),
    rawOtherText: z.string(),
  })
  .passthrough();

export const answersInput = z.record(z.string(), z.string().max(4000));
export const textInput = z.object({ text: z.string().min(1).max(400_000) });

/**
 * `POST /api/prose/facts`. The context is optional and additive: without it every checklist item
 * reports `unattributed`, which is honest but strips the origin distinction the checklist exists
 * for (see `factSourcesFromKnowledge`). A caller that holds the profile and the program should
 * send them.
 */
export const factsInput = textInput.extend({
  profile: profileInput.optional(),
  program: programInput.optional(),
  funder: funderInput.optional(),
  answers: answersInput.optional(),
});
