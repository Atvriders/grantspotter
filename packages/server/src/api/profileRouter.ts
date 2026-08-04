import { Router } from 'express';
import type { Profile, Program } from '@grantspotter/core';
import { orgProfileSchema, studentProfileSchema } from '@grantspotter/core';
import { createProgramRepo } from '../db/repositories/programs.js';
import type { RouterDeps } from './deps.js';
import { AppError } from './errors.js';
import {
  isProfileKind,
  loadActiveProfile,
  loadAllProfiles,
  saveProfile,
} from './profileStore.js';
import { computeCompleteness, emptyCompleteness } from './completeness.js';

/** RESOLUTIONS R1: whole records only ever come from Plan 1's repository. */
function loadCorpus(db: RouterDeps['db']): Program[] {
  return createProgramRepo(db).list();
}

export function createProfileRouter(deps: RouterDeps): Router {
  const router = Router();

  router.get('/', deps.requireAuth, (req, res) => {
    const user = deps.currentUser(req);
    const profiles = loadAllProfiles(deps.db, user.id);
    // Re-read rather than pick from `profiles` above, so "which profile does the
    // meter speak for?" has exactly one definition in this codebase — the one in
    // profileStore. A second copy of that preference order here is how the
    // browse page and the profile page end up disagreeing about the same user.
    const active = loadActiveProfile(deps.db, user.id);
    const corpus = loadCorpus(deps.db);
    res.json({
      student: profiles.student,
      organization: profiles.organization,
      completeness:
        active === null
          ? emptyCompleteness(corpus.length)
          : computeCompleteness(active.profile, corpus, deps.now()),
    });
  });

  router.put('/:kind', deps.requireAuth, (req, res, next) => {
    const user = deps.currentUser(req);
    const kind = req.params.kind;
    if (!isProfileKind(kind)) {
      next(
        new AppError(
          'validation_failed',
          `Unknown profile kind "${kind}". Expected "student" or "organization".`,
        ),
      );
      return;
    }

    // The discriminant is checked before the schema so the client is told the
    // route and the body disagree, rather than being handed a wall of zod
    // issues about every field of the wrong variant.
    const body: unknown = req.body;
    const bodyKind =
      typeof body === 'object' && body !== null ? (body as { kind?: unknown }).kind : undefined;
    if (bodyKind !== kind) {
      next(
        new AppError(
          'validation_failed',
          `Body kind "${String(bodyKind)}" does not match the route kind "${kind}".`,
        ),
      );
      return;
    }

    const schema = kind === 'student' ? studentProfileSchema : orgProfileSchema;
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      next(new AppError('validation_failed', 'Profile failed validation.', parsed.error.issues));
      return;
    }

    // `parsed.data`, never `req.body`: zod strips every key CONTRACT §3 does not
    // define, and this is what lands in `profiles.data` as JSON. Persisting the
    // raw body would make the column a place for a client to store whatever it
    // liked, under a key some later reader might trust.
    const profile: Profile = parsed.data;
    saveProfile(deps.db, user.id, kind, profile, deps.now());

    res.json({
      profile,
      completeness: computeCompleteness(profile, loadCorpus(deps.db), deps.now()),
    });
  });

  return router;
}

export function createMeRouter(deps: RouterDeps): Router {
  const router = Router();

  router.get('/', deps.requireAuth, (req, res) => {
    const user = deps.currentUser(req);
    const profiles = loadAllProfiles(deps.db, user.id);
    const active = loadActiveProfile(deps.db, user.id);
    const corpus = loadCorpus(deps.db);
    res.json({
      user,
      hasStudentProfile: profiles.student !== null,
      hasOrgProfile: profiles.organization !== null,
      completeness:
        active === null
          ? emptyCompleteness(corpus.length)
          : computeCompleteness(active.profile, corpus, deps.now()),
    });
  });

  return router;
}
