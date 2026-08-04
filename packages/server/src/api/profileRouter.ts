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

  router.get('/', deps.requireAuth, (req, res, next) => {
    const user = deps.currentUser(req);
    const profiles = loadAllProfiles(deps.db, user.id);

    // `?profile=` is the same spelling `GET /api/programs` already reads
    // (`req.query.profile`, gated by `isProfileKind`) — one name for "which
    // profile did you mean", not a second one invented here. Unlike that
    // route, an unrecognised value is refused rather than silently treated as
    // "no preference": this endpoint is what a user reads directly after
    // switching tabs on the profile page, so a typo'd or stale query value
    // should say so, not quietly fall back to a profile they didn't ask for.
    const rawPrefer = req.query.profile;
    if (rawPrefer !== undefined && !isProfileKind(rawPrefer)) {
      next(
        new AppError(
          'validation_failed',
          `Unknown profile kind "${String(rawPrefer)}" in "profile". Expected "student" or "organization".`,
        ),
      );
      return;
    }
    const prefer = isProfileKind(rawPrefer) ? rawPrefer : undefined;

    // Re-read rather than pick from `profiles` above, so "which profile does the
    // meter speak for?" has exactly one definition in this codebase — the one in
    // profileStore. A second copy of that preference order here is how the
    // browse page and the profile page end up disagreeing about the same user.
    //
    // A named preference is not a hint that falls back (see `loadActiveProfile`'s
    // own doc comment): preferring a profile the caller does not hold answers
    // `null`, exactly as the no-preference path already does when nothing is
    // held at all. There is no second "did they mean it" branch here to fabricate
    // one.
    const active = loadActiveProfile(deps.db, user.id, prefer);
    const corpus = loadCorpus(deps.db);
    res.json({
      student: profiles.student,
      organization: profiles.organization,
      // A user may hold BOTH profiles and there is exactly one report, so the
      // report has to say whose it is. Without this the UI can only guess, and
      // the only way to guess is to rebuild PROFILE_KIND_PRIORITY in the
      // browser — a second definition of "which profile does the meter speak
      // for?", which is precisely what the comment above refuses. `null` means
      // no profile was evaluated, not "student by default".
      completenessFor: active?.kind ?? null,
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
      // The report is for the profile just saved, whatever the default order
      // would have picked.
      completenessFor: kind,
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
      // See the note on GET /api/profiles: one report, up to two profiles, so
      // the report names the profile it speaks for rather than leaving the
      // browser to re-derive the preference order.
      completenessFor: active?.kind ?? null,
      completeness:
        active === null
          ? emptyCompleteness(corpus.length)
          : computeCompleteness(active.profile, corpus, deps.now()),
    });
  });

  return router;
}
