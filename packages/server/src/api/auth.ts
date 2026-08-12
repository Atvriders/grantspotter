import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { BootstrapState } from '../auth/bootstrap.js';
import { requireAuth } from '../auth/middleware.js';
import {
  assertPasswordPolicy,
  hashPassword,
  verifyPasswordConstantTime,
  WeakPasswordError,
} from '../auth/password.js';
import {
  coarseOrigin,
  createConcurrencyGate,
  createRateLimiter,
  createThresholdNotice,
  QueueFullError,
  type HashRoute,
  type RateLimitAttempt,
  type RateLimiter,
} from '../auth/rateLimit.js';
import {
  newSessionId,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  sessionCookieOptions,
  sessionIdHash,
  signSessionCookie,
} from '../auth/session.js';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/migrate.js';
import { appendAuditLog } from '../db/repositories/ingestion.js';
import { createSessionRepo } from '../db/repositories/sessions.js';
import {
  createUserRepo,
  normalizeEmail,
  toPublicUser,
  type UserRecord,
} from '../db/repositories/users.js';
import { EMAIL_SHAPE } from './adminUsersRouter.js';
import { asyncHandler } from './asyncHandler.js';
import { AppError } from './errors.js';

export interface AuthRouterDeps {
  db: Db;
  config: AppConfig;
  bootstrap: BootstrapState;
  loginLimiter: RateLimiter;
  /**
   * THE NARROWEST RUNG OF THE REGISTRATION LADDER — see `REGISTRATION_MAX_PER_CONNECTION` for what
   * it is keyed on, what it costs the people it is not aimed at, and what it cannot bound.
   *
   * OPTIONAL, and it defaults to the shipped window below, so that changing what this route counts
   * did not require editing `app.ts` — which builds this bundle. `app.ts` already defaults
   * `loginLimiter` the same way. Nothing injects it today: the shipped numbers are reachable in
   * two hundred and one requests, and `enroll.test.ts` says why testing the configuration that
   * ships is worth more than testing a smaller one.
   */
  registrationLimiter?: RateLimiter;
}

/**
 * The SIGN-IN body. `min(1)` is deliberate and must stay.
 *
 * A length floor belongs at the points that SET a credential, never at the point that
 * CHECKS one. Raising this to the policy minimum would (a) permanently lock out anyone
 * who already holds a shorter password — a restored database, a migration from an older
 * release, an account an operator inserted by hand — since there would then be no body
 * that both matches their password and passes the schema, and (b) leak the policy to an
 * unauthenticated attacker, because a below-floor guess would answer 422 where an
 * above-floor guess answers 401. Every wrong password must be the same 401.
 *
 * The floor for CREATING a credential is `assertPasswordPolicy` (auth/password.ts),
 * applied in the bootstrap handler below. It is the only route in the server that takes
 * a caller-chosen password: `adminUsersRouter` generates the passwords it stores.
 */
const credentialsSchema = z.object({
  email: z.string().min(3).max(320),
  password: z.string().min(1).max(512),
});

const bootstrapSchema = credentialsSchema.extend({
  token: z.string().min(1).max(256),
  displayName: z.string().max(120).optional(),
});

/**
 * THE REGISTRATION BODY, and the two fields that are conspicuously absent from it.
 *
 * There is no `role`. Not "role, validated"; not "role, defaulted" — no role at all, so that the
 * only way this route could ever mint an administrator would be for somebody to add the field
 * here. zod strips keys an object schema does not declare, so a body carrying `"role":"admin"`
 * reaches the handler with that key gone, and the handler passes the literal `'member'`.
 *
 * AND THERE IS NO `code`, WHICH IS THE 2026-08-11 CHANGE. Until today this route took an enrollment
 * code an administrator had issued, and everything else in this file was shaped around guarding it.
 * The owner's decision was that the locked door cost more than it bought — every legitimate member
 * waited on an officer — so registration is open: anybody who can reach this deployment creates
 * their own member account. `migrations/095` carries the argument in full.
 *
 * A body that still carries `code` is not refused. zod strips it, so a browser tab left open across
 * the upgrade — which is holding the OLD sign-up form, with a code field in it — posts successfully
 * instead of being answered with a validation error it has no wording for.
 *
 * `password` is `min(1)` for the same reason the sign-in schema is, but it does NOT stay there:
 * `assertPasswordPolicy` runs in the handler. A length floor in the schema would answer 422 for a
 * short password and something else for a long wrong one, which is a difference an attacker can
 * measure; the floor belongs at the point that SETS a credential, and it is enforced there.
 */
const registrationSchema = z.object({
  email: z.string().trim().min(3).max(254).regex(EMAIL_SHAPE, 'Not an email address.'),
  password: z.string().min(1).max(512),
  displayName: z.string().trim().max(120).optional(),
});

/**
 * HOW MANY ACCOUNTS THIS SERVER WILL CREATE FOR STRANGERS, AND THE THREE DIFFERENT SUBJECTS THE
 * QUESTION HAS TO BE ASKED ABOUT.
 *
 * ================================================================================================
 * THE CEILING, IN PLAIN WORDS, ON THE DEPLOYMENT THIS PRODUCT ACTUALLY HAS. Read this paragraph and
 * nothing else if you are an operator: the README says the same thing in the same numbers.
 *
 *   GrantSpotter runs behind a Cloudflare Tunnel. Every request arrives on ONE TCP connection from
 *   cloudflared, and cloudflared reports the caller's own public address in `X-Forwarded-For`.
 *   So the two ceilings you will ever meet are:
 *
 *     200 accounts, per public address, per fifteen minutes.  <- one building, one lecture hall,
 *                                                                one home, one campus NAT.
 *     400 accounts, for the whole deployment, per fifteen minutes.
 *
 *   A LECTURE HALL OF 130 STUDENTS ON ONE CAMPUS NAT FITS IN ONE SITTING. That sentence is the
 *   design load and it is stated because until this change it was FALSE: the per-address rung was
 *   60, so the 131st person in the room — in practice the 61st — was refused, and the room had to
 *   be onboarded in three fifteen-minute shifts. IF YOU ARE PLANNING AN INTAKE BIGGER THAN 200
 *   PEOPLE IN ONE ROOM, split it across two sittings a quarter of an hour apart, or have the
 *   overflow sign up from a phone on mobile data — that is a different public address and a
 *   different bucket. Nobody who already has an account is affected by any of this: signing in is
 *   not rationed.
 *
 * THE THIRD RUNG IS UNREACHABLE BEHIND A TUNNEL AND IS NOT PART OF THAT ANSWER. See below.
 * ================================================================================================
 *
 * ================================================================================================
 * WHY THOSE NUMBERS MOVED (the third review of 2026-08-12), AND THE ONE MISTAKE UNDERNEATH BOTH OF
 * THE PREVIOUS SETS. Everything below the next banner was derived on a deployment nobody has.
 *
 *   THE HEADLINE MEASUREMENT WAS TAKEN WITH "130 STUDENTS FROM 130 DISTINCT ADDRESSES". That gives
 *   every student their own `req.ip` and therefore their own connection bucket, so the rung that
 *   fired in it was the NETWORK rung — which is why the last change doubled the network rung to 240
 *   and left the connection rung alone. Behind the tunnel there are no 130 addresses. A co-located
 *   intake is one building's NAT: ONE value of `req.ip` for the whole room. MEASURED here against
 *   the built server, 130 students on ONE NAT, six submits at a time: `{"201":60,"429":70}`, 61
 *   rows in `users`, one audit row — the CONNECTION rung, at 60, doing all of the refusing. The
 *   scenario the last change used as its own success metric was refused by the one rung it did not
 *   look at.
 *
 *   AND THE "DOUBLED FOR RETRIES" RULE THAT SET 60 HAD ALREADY EXPIRED. Sixty was "thirty students
 *   doubled, which leaves room for the retries a real form produces — a rejected password, a second
 *   address, a reload". NONE OF THOSE CHARGE ANYTHING ANY MORE: the budget is charged by
 *   `users.create` and by nothing else, so a mistyped password, a taken address, a shed request, a
 *   lost race and a reload are all free. Doubling a population to pay for retries that are free is
 *   paying twice for nothing, and it left the real figure — how many PEOPLE are in the room —
 *   buried under a factor of two that had stopped meaning anything. The rungs below are counts of
 *   PEOPLE.
 * ================================================================================================
 *
 * ================================================================================================
 * WHAT CHANGED EARLIER ON 2026-08-12, AND THE THREE MEASURED FACTS THAT CHANGED IT. Everything below this
 * banner was written on 2026-08-11 for a ladder that counted ATTEMPTS. Three verifiers then
 * measured it against a running server and the ladder did not survive contact with the deployment
 * this product actually has — one Cloudflare Tunnel, therefore one TCP peer for every human being
 * who will ever use it.
 *
 *   1. A REQUEST THAT CREATED NOTHING SPENT THE BUDGET FOR REQUESTS THAT WOULD HAVE. MEASURED here
 *      against the built server: 120 POSTs naming an address that already had an account — 147 ms,
 *      120 ms of CPU, zero argon2id, zero rows — and the next honest student was refused, with
 *      `SELECT COUNT(*) FROM users` returning 1. Creating those 120 accounts for real would have
 *      cost 5.7 s of CPU. So denying registration to a whole deployment was ~40x cheaper than
 *      using it, and the paragraph below claiming "MASS REGISTRATION AND DENIAL OF REGISTRATION
 *      ARE THE SAME ACT HERE" was false by two orders of magnitude at the moment it was written.
 *
 *   2. A FLOOD ON THE OTHER ROUTE SPENT IT TOO. `POST /api/auth/login` shares the hash gate. A
 *      sign-in flood filled the gate, the gate shed the registrations waiting in it, and every shed
 *      registration had ALREADY charged all three rungs on its way past. MEASURED: 130 students
 *      from 130 distinct addresses during a 1,642 req/s sign-in flood produced 37 accounts, 83 of
 *      them shed by the gate and 10 refused by the ladder — and 37 + 83 is exactly 120, the network
 *      rung, spent to the last unit by requests this server itself threw away.
 *
 *   3. THE DEPLOYMENT RUNG IS UNREACHABLE ON THE DEPLOYMENT IT SHIPS TO. MEASURED: four connections
 *      making sixty registrations each from one TCP peer — 120 created, 120 refused. Behind the
 *      tunnel the peer is one value, so `REGISTRATION_MAX_DEPLOYMENT` can never be charged by
 *      anybody and the real ceiling is the network rung. Which was 120 — exactly the design load
 *      the derivation below names ("two clubs onboarding the same evening at sixty each"). Zero
 *      margin, and an attacker took all of it with 120 requests.
 *
 * THE FIX IS ONE DECISION APPLIED THREE TIMES: THE BUDGET COUNTS WHAT ITS NAME SAYS. It is called
 * "how many accounts this server will create", so it is charged when an account is created and at
 * no other moment. A slot is CLAIMED before the work starts and released if the work does not end
 * in a row — `RateLimiter.begin`, the same primitive and the same reasoning as everywhere else in
 * this file, because a budget read before an `await` and charged after it is not a budget.
 *
 * WHAT THAT BUYS, IN THE ORDER OF THE THREE FACTS ABOVE:
 *   1. Denial now costs exactly what abuse costs, which is the sentence this file was already
 *      making and could not back. To hold sign-up shut for a window you must genuinely create the
 *      whole ceiling in accounts: real argon2id, real rows, one audit row naming the rung, and an
 *      Admin -> Users screen an administrator can select and delete. Probing, being shed, losing a
 *      race and being refused all cost the caller a request and cost everybody else nothing.
 *   2. A request the gate sheds is not a registration and no longer charges one.
 *   3. The rung that has to clear the busiest honest window is the one that is REACHABLE on the
 *      deployment this ships to, which is the network rung. It is the deployment ceiling behind a
 *      tunnel and it is sized as one; the deployment rung is what the direct-facing shape adds on
 *      top of it, and it is stated as that rather than as the real limit.
 *
 * AND WHAT IT COSTS, stated rather than rounded off. An attacker who is willing to create accounts
 * gets more of them than before: 400 per window from one network, where the first version of this
 * ladder allowed 120. That is the price of the refusal being honest AND of the honest intake
 * fitting, and it is the right way round — junk accounts are visible, enumerable, deletable in bulk
 * and bounded at 38 MB of database a day, while a sign-up route that anybody can switch off for
 * 0.13 requests a second is none of those things.
 *
 * THE ACCOUNT-EXISTENCE ORACLE IS NO LONGER BOUNDED AT ALL, AND THAT IS SAID OUT LOUD RATHER THAN
 * LOST IN THE CHANGE. The old design charged a probe to the ladder, which bounded it at a few
 * hundred questions a window — the derivation below is proud of that and it is deleted here. It has to go
 * with the rest: a probe creates nothing, and charging things that create nothing is precisely
 * defect 1. What is left is honest and worse-sounding: anybody who can reach this route can ask
 * whether any address has an account, as fast as HTTP will carry it. THAT WAS NEVER CLOSED
 * ANYWAY, and pretending otherwise was the more expensive half. A miss creates the account and
 * answers 201; a hit answers 409. No rationing of the SENTENCE changes those two status lines, so
 * a budget on the answer bought a bound on the polite version of a fact the protocol states for
 * free — and it charged an attacker's questions to the students' budget to do it. The oracle is
 * inherent to open sign-up with no email verification (`README`: no SMTP, no reset mail). What is
 * bounded is the SQUATTING — a miss creates a real account and is charged like one — and what is
 * visible is the reading: `ADDRESS_TAKEN_NOTICE` writes the operator a row.
 * ================================================================================================
 *
 * THE THREAT MODEL FLIPPED ON 2026-08-11 AND THIS LADDER HAD TO FOLLOW IT. Everything below was
 * built against "guess a secret": the numbers were charged ONLY on the branch that answered "that
 * enrollment code is not valid", which is what made it safe for the lower rungs to be as coarse as
 * they are — somebody holding a real code never read them, never charged them, and could not be
 * refused by them however hard a stranger had been knocking. That branch no longer exists. There is
 * no code, so there is no wrong code, so a ladder that only ever fired on wrong codes protects
 * NOTHING, and the honest choice was to delete it or to re-point it. It is re-pointed, and the
 * property that made it affordable is exactly the one that is now gone: THIS BUDGET IS ON THE PATH
 * OF EVERY LEGITIMATE REGISTRATION. It cannot be sized against an attacker any more. It has to be
 * sized against the busiest honest afternoon this product is for, and everything below is that
 * derivation.
 *
 * THE ABUSE IT IS AGAINST IS MASS ACCOUNT CREATION, and the costs are real rather than notional:
 * every registration is an argon2id hash (19 MiB, two passes) and a row that never goes away by
 * itself. Unbounded, that is a disk-fill and an unusable Admin -> Users screen, arriving as fast as
 * the hash gate will serve it.
 *
 * WHAT NO SETTING OF THESE NUMBERS CAN DO, SAID FIRST BECAUSE IT DECIDES THE REST. A public
 * instance cannot separate a hundred people signing up from one person signing up a hundred times.
 * The only signals this process has are a header the caller writes and a TCP peer that is one value
 * for every user behind the operator's tunnel; neither is an identity, and there is no email
 * verification in this product to stand in for one (`README` says so: no password-reset mail, no
 * SMTP anywhere). So a deployment-wide ceiling that stops mass creation is also a deployment-wide
 * ceiling somebody can spend on purpose: MASS REGISTRATION AND DENIAL OF REGISTRATION ARE THE SAME
 * ACT HERE, and the ceiling only chooses which of the two an attacker gets.
 *
 * THAT SENTENCE WAS AN ASPIRATION WHEN IT WAS WRITTEN AND IS A PROPERTY NOW. It was false by ~40x
 * on 2026-08-11 (see fact 1 in the banner), because a probe, a shed request and a lost race all
 * charged the same as a created account while costing a fraction of one. It is true because the
 * budget is charged by the INSERT and by nothing else, and it is the reason this file can honestly
 * say the two are the same act: whichever of them an attacker is after, they pay a real argon2id
 * and leave a real row per unit of it. What is left to do is to make either one bounded, loud and
 * reversible — bounded by the numbers below, loud by the audit rows this file writes, reversible
 * because an administrator can delete the accounts and the refusal lasts fifteen minutes rather
 * than forever. An operator who needs more than that needs a signal we do not have, which means an
 * authenticating proxy in front of this process.
 *
 * THE THING THAT MAKES THIS HARD, said before the answer, and unchanged by the flip: behind the
 * operator's Cloudflare Tunnel the TCP peer is ONE VALUE FOR EVERY USER, and `X-Forwarded-For` is
 * the only per-client signal there is — and that header is written by the client when the process
 * is reachable directly. One key cannot be both per-client and unforgeable. There is no arrangement
 * of a single bucket that is not either evadable or a deployment-wide off switch, which is why the
 * answer is not a key but a LADDER: a precise forgeable one, then two coarse unforgeable ones
 * underneath it.
 *
 * WHAT IS COUNTED IS AN ACCOUNT THAT EXISTS, AND NOTHING ELSE.
 *
 * IT USED TO BE EVERY ATTEMPT THAT REACHED THE ADDRESS, and the paragraph that stood here defended
 * that on two grounds. The first is still right and is why this is not a failure counter: THE
 * SUCCESSES ARE THE ABUSE, and a budget that counted only mistakes would let somebody who never
 * makes one create accounts without limit. The second was that charging every attempt "makes the
 * existence oracle affordable", and it is deleted — it bought a bound on the polite wording of a
 * fact the status line gives away for free (409 against 201), and it paid for it by letting a
 * stranger's questions close the students' door. See the banner.
 *
 * So: the slot is CLAIMED when a registration starts and CHARGED when `users.create` has returned.
 * A request that is refused by a rung, told the address is taken, shed by the hash gate, or that
 * loses the duplicate-address race, releases its slot and leaves no mark on any of the three.
 *
 * CLAIMED IN ONE SYNCHRONOUS STRETCH, BEFORE THE `await`, WHICH IS WHY THIS IS `begin` AND NOT
 * `check`. Reading a counter and writing to it with an argon2id hash in the gap is not a limit at
 * all: every request that arrives before the first hash returns reads a total none of them have
 * paid into. That defect has shipped in this file twice (measured 2026-08-05: 240 concurrent
 * requests against a budget of ten produced 240 hashes and 10.2 s of CPU). Charging on success
 * ALONE would have shipped it a third time — success is not known until after the hash — so the
 * slot is taken before the hash and only converted into a recorded registration after the INSERT.
 * An attempt in flight occupies the budget exactly as a created account does, which is what makes
 * the concurrent and the sequential answer the same number; `RateLimitAttempt` carries the rest.
 *
 * WHAT EACH RUNG COSTS THE PEOPLE IT IS NOT AIMED AT — the question this codebase has got wrong
 * four times, and the only one that decides a number. Every one of these is derived from the
 * INTENDED USE, because every one of them is on the honest path:
 *
 *   CONNECTION (`req.ip`, TWO HUNDRED). Behind the documented single hop this is the address the
 *   tunnel reported. IT IS THE RUNG THAT FIRES FOR A CO-LOCATED INTAKE, which is the thing this
 *   product is for and the thing two previous derivations of these numbers never measured: a
 *   lecture hall, a club room and a campus are ONE public address, so the entire room shares ONE
 *   bucket. It is therefore sized in PEOPLE IN A ROOM. The largest honest one this product has a
 *   scenario for is a full lecture hall, measured at 130; two hundred holds that with half again
 *   over it, and every unit of it is a real account with a real row rather than a press of a
 *   button, because retries are free (see the banner).
 *
 *   IT WAS SIXTY AND THAT REFUSED SEVENTY OF THE HUNDRED AND THIRTY. Sixty was thirty doubled for
 *   retries that no longer cost anything; "thirty" was a club committee, not a room. Ten before
 *   that, while it counted wrong codes. Forgeable when nothing sits in front of this process, which
 *   is why it is the top rung and not the only one — and NOT forgeable behind the tunnel, because
 *   Cloudflare appends the real client address to `X-Forwarded-For` and `trust proxy` 1 takes the
 *   rightmost entry, so on the shape that ships this is a genuine per-building key.
 *
 *   NETWORK (the coarsened TCP peer, FOUR HUNDRED). Unforgeable: no header changes
 *   `req.socket.remoteAddress`, and `coarseOrigin` cuts it to a /24 or /48 so an attacker holding
 *   an IPv6 allocation gets one bucket rather than 2^64 of them.
 *
 *   THIS IS THE DEPLOYMENT CEILING ON THE DEPLOYMENT THIS SHIPS TO. Behind the tunnel every human
 *   being who will ever use the instance arrives on one peer, so this rung — not the one below it —
 *   is what the busiest honest window has to clear, and it is what an operator should read as "the
 *   whole instance". It is EXACTLY TWICE THE CONNECTION RUNG, and the ratio is the property rather
 *   than the number: two full lecture halls onboarding in the same quarter of an hour is the
 *   busiest thing anybody has described, and a single building can never spend more than half of
 *   it, so one room running long can never close sign-up for the other. It was 120 (one design
 *   load, zero margin), then 240 (a design load derived from a deployment with 130 separate
 *   addresses in it).
 *
 *   SERVER (everything, EIGHT HUNDRED). Also unforgeable, since it has no key at all. It exists for
 *   the caller the rung above cannot see: a hundred machines in a hundred networks, each politely
 *   under 400. TWICE THE NETWORK RUNG ON PURPOSE, and that ratio is the property rather than the
 *   number — a rung that refuses charges NOTHING, so a single network can never put more than its
 *   own 400 into this counter, and closing it therefore takes at least two networks acting
 *   together. One caller cannot reach the deployment-wide switch, which is the 2026-08-05 lesson
 *   expressed as arithmetic instead of as a hope.
 *
 *   AND ON THE OWNER'S DEPLOYMENT IT IS UNREACHABLE, which is stated as the design rather than
 *   discovered as a defect. Behind one tunnel there is one network, so this rung can never be
 *   charged past the network rung's 400 and the deployment ceiling IS 400. It is kept because the
 *   direct-facing and multi-hop shapes are real deployments too and it is the only rung that bounds
 *   them; the rung which has to clear the honest load is the one that can actually fire on the
 *   shape that ships.
 *
 * MEASURED ON THIS HOST, 2026-08-12, against the BUILT server in its own process on a fresh
 * DATA_DIR (36 cores, Node v20.11.0), before and after this change:
 *
 *                                                        before            after
 *   120 probes at an address that exists, then one
 *   honest student from another connection               429 refused       201 created
 *   (the probes create nothing either way; before,
 *   they spent the whole network rung in 147 ms)
 *
 *   130 students, 130 addresses, during a 1,642 req/s
 *   sign-in flood on the other route                     37 created        129 created
 *                                                        83 shed, 10 refused
 *
 *   four connections x 60 registrations, one peer        120 created       240 created
 *
 *   60 registrations vs 60 probes, CPU                   2,840 vs 70 ms    2,860 vs 70 ms
 *   what the 60 probes then cost everybody else          the network rung  nothing
 *
 * AND MEASURED AGAIN THE SAME DAY, in the shape the owner actually deploys — one TCP peer, one
 * NAT address for the whole room, six submits at a time — before and after the rungs were
 * re-derived above:
 *
 *                                                        before            after
 *   130 students, ONE campus NAT, one tunnel             60 created        130 created
 *                                                        70 refused        0 refused
 *
 * WHAT AN ATTACKER CAN STILL REACH, stated rather than rounded off. 800 accounts per fifteen
 * minutes deployment-wide and 400 of them from any one network, sustained: 76,800 a day, or 38,400
 * behind the tunnel. MEASURED at 983 bytes of checkpointed SQLite per account (a reviewer measured
 * 1,024 on the same shape) — THREE rows, not the two an earlier draft of this paragraph assumed:
 * `users`, `audit_log` AND `sessions`, because registration signs the new member in, and 100
 * registrations produced 101 rows in that table. So about 75 MB of database a day, and an
 * Admin -> Users screen with a day's worth of junk in it. The trade is in the banner: the same 800
 * is what a caller must genuinely CREATE to hold registration closed for everybody else, where the
 * first version of this ladder let 240 requests that created nothing do it.
 * Every window of it writes an audit row naming the rung and the source network. That is the bound,
 * and it is a bound on damage rather than a claim that the abuse is prevented.
 *
 * TWO SMALLER PROPERTIES THAT FALL OUT OF THE LADDER AND ARE WORTH NAMING, because both were
 * defects before it. A rung that refuses charges nothing and a rung only records a created account,
 * so the per-origin map can only ever gain a key on one of the ≤800 registrations a window that get
 * all the way through — a caller rotating `X-Forwarded-For` used to add a key per request — and
 * `createRateLimiter` now sweeps what is left rather than holding it until the process restarts.
 * And the same bound applies to the announcement map, so the audit trail cannot be flooded by a
 * caller who mints fresh keys; see `announceOnce`.
 *
 * A SUCCESSFUL REGISTRATION DOES NOT RESET ANY OF THEM, and here that is not even a judgement call:
 * a success is the thing being counted.
 *
 * NONE OF THEM CLAIMS TO BOUND THE WORK PER SECOND. They bound how many registrations a window
 * contains; `hashGate` is what bounds how much argon2id is in flight at any instant and whose turn
 * it is, and it is what keeps a burst of registrations from making a member wait to sign in.
 */
export const REGISTRATION_WINDOW_MS = 15 * 60 * 1000;
export const REGISTRATION_MAX_PER_CONNECTION = 200;
export const REGISTRATION_MAX_PER_NETWORK = 400;
export const REGISTRATION_MAX_DEPLOYMENT = 800;

/**
 * THE ONE KEY THE DEPLOYMENT-WIDE RUNG USES. A constant, because the whole point of that rung is
 * that there is nothing about the caller in it: a key is a thing an attacker can rotate, and this
 * one deliberately offers them nothing to rotate.
 */
const DEPLOYMENT_KEY = 'deployment';

/**
 * HOW MANY "THAT ADDRESS ALREADY HAS AN ACCOUNT" ANSWERS ONE SOURCE NETWORK GETS BEFORE AN OPERATOR
 * IS TOLD, and the number refuses nothing whatsoever.
 *
 * THIS REPLACES `ENROLLMENT_CONFLICT_MAX`, WHICH RATIONED THE ANSWER ITSELF AND CANNOT SURVIVE OPEN
 * REGISTRATION. That budget was keyed on the digest of the code the question was asked with — a key
 * a caller could not mint, because minting one meant obtaining a second real credential. With no
 * code there is no such key left: every candidate (the address asked about, `req.ip`, a session
 * that does not exist) is either chosen by the caller or shared by the whole deployment, and a
 * budget whose key the caller writes is not a budget.
 *
 * AND FOR ONE DAY THIS PARAGRAPH CLAIMED THE LADDER BOUNDED THE QUESTION INSTEAD — "a probe IS a
 * registration attempt, charged to all three rungs, so 240 addresses per window deployment-wide is
 * the whole oracle". That is deleted, for the reason the banner on `REGISTRATION_WINDOW_MS` gives:
 * it bought a bound on the polite wording of something the status line says for free (409 for an
 * address that exists, 201 for one that does not), and it paid for it by letting a stranger's
 * questions spend the budget the students needed — MEASURED, 120 probes shutting sign-up for the
 * whole tunnel in 147 ms. The oracle is open, it was always open, and nothing this file can do
 * closes it short of refusing to create accounts. What is bounded is what a probe LEAVES BEHIND: a
 * miss is a real account and is charged like one. What this constant does is make the reading of a
 * list visible to an operator, which is the only thing left that is worth doing.
 *
 * TWENTY, and like `FAILED_SIGN_IN_NOTICE` it is set where a busy day will occasionally trip it
 * rather than where only an attack will, because being wrong about it costs one audit row per
 * source network per window and nothing else. Nobody is refused, delayed, or answered differently.
 * A club intake produces a handful of people who signed up last term and forgot; twenty of them
 * from one network inside fifteen minutes is somebody reading a list.
 */
const ADDRESS_TAKEN_NOTICE = 20;

/**
 * HOW MANY argon2id OPERATIONS THIS PROCESS WILL HAVE IN FLIGHT AT ONCE, across both
 * unauthenticated routes that perform one.
 *
 * FOUR, matching libuv's default thread-pool size, which is where `@node-rs/argon2` actually runs:
 * past that the operating system is queueing these anyway, and a queue we can see is worth more
 * than one we cannot — it bounds peak resident memory at four times argon2id's 19 MiB, and it
 * gives `authCost.test.ts` a number to assert instead of a hope.
 */
const MAX_CONCURRENT_HASHES = 4;

/**
 * HOW MANY MAY BE WAITING FOR ONE OF THOSE FOUR SLOTS, and why a ceiling had to exist at all.
 *
 * THIS PARAGRAPH USED TO SAY THERE WAS NO CEILING, and said it as a virtue: "everything past it
 * waits and is then served; nothing is refused". MEASURED on this host, 2026-08-09: a stranger with
 * no code and no account, opening 512 connections and POSTing `/api/auth/login` with a fresh email
 * per request — which the `(peer, email)` sign-in counter can never fire on — took a student's
 * enrolment from 81 ms to 4,881 ms, and the figure rose in step with their connection count
 * (24 connections 243 ms, 96 → 967 ms, 256 → 2,507 ms) because the depth of the queue was theirs
 * to choose.
 * A caller who can choose everyone's wait can choose a wait longer than everyone's patience, at
 * which point every one of those hashes is CPU spent on somebody who has already closed the tab.
 * "Nothing is refused" was not generosity; it was the denial of service with the word removed.
 *
 * THIS NUMBER USED TO CARRY THE PROMISE ABOUT THE WAIT AND IT NO LONGER DOES, because the promise
 * was arithmetic and the arithmetic was measured on an idle machine. It said: four-way argon2id
 * costs 42 ms a hash, so a full queue of 256 drains in 256/4 x 42 ms = 2.7 s, "the worst wait this
 * gate will impose on anybody". MEASURED on this host, 2026-08-12, against the built server under a
 * 1,642 req/s sign-in flood across 250 lanes: the effective slot cost is 168 ms, not 42, and ten
 * consecutive member sign-ins took 10,431-14,186 ms (median 10,680 ms) against a 41 ms baseline.
 * Four times the promised worst case, on the very hardware the promise was derived from — because
 * the 42 ms belongs to a machine doing nothing else, and a queue this deep only exists when the
 * machine is doing a great deal else.
 *
 * SO THE DEPTH IS NOW THE WAITING ROOM AND `MAX_QUEUE_WAIT_MS` IS THE PROMISE. Two hundred and
 * fifty-six stays; what has to hold is the RELATIONSHIP between the two numbers. At the 43 ms slot
 * cost measured here when a single lane floods, a full queue drains in 256/4 x 43 ms = 2.75 s,
 * inside the 3 s promise — so on this hardware a queue full of people who are genuinely waiting is
 * served rather than timed out, and the deadline only fires when the machine is slower than this
 * arithmetic assumes. Which is exactly the case the arithmetic used to get wrong silently.
 *
 * IT WAS CUT TO 192 IN THIS SAME CHANGE AND PUT BACK, and that is recorded because only the
 * measurement caught it. Shallower looked strictly safer — less memory, a shorter worst wait — and
 * MEASURED against the built server it turned 130 students arriving during a sign-in flood into 97
 * accounts and 33 refusals, where 256 makes all 130. The queue is shared by two routes that shed
 * toward equal occupancy, so each route's half has to hold a whole crowd by itself: 130 students
 * need 130 places and half of 192 is 96. A depth is not a safety margin, it is a waiting room, and
 * making it smaller turns people away.
 *
 * IT IS NOT A PER-CALLER BUDGET AND CANNOT BE SPENT ON ANYBODY ELSE'S BEHALF. The gate is
 * round-robin between callers AND between the two routes, and sheds whoever holds the largest
 * share, so a flood displaces only itself; 256 is reached by legitimate traffic only when 256
 * DIFFERENT people are waiting at once, which is an order of magnitude past a club intake and is
 * real load rather than an attack.
 */
const MAX_QUEUED_HASHES = 256;

/**
 * THE LONGEST THIS GATE WILL MAKE ANYBODY WAIT IN ITS QUEUE BEFORE STARTING THEIR HASH. That is the
 * whole claim, and the four words that had to be added to it are "in its queue".
 *
 * WHAT IT DOES NOT PROMISE, FIRST, BECAUSE THAT IS WHERE THIS PARAGRAPH WENT WRONG. It is not a
 * bound on how long a person waits for an answer. This clock starts when `hashGate.run` is called
 * and stops when the hash starts; everything either side of that is an event loop nothing in this
 * file bounds. MEASURED on this host, 2026-08-12, against the built server with the flood generated
 * from four separate processes: forty registrations under a 1,893 req/s sign-in flood took min
 * 245 ms, MEDIAN 41,410 ms and MAX 45,603 ms end to end (a second run at 1,852 req/s: 277 /
 * 42,621 / 46,374). Every one of the eighty was answered 201 and NOT ONE was refused for having
 * waited, so the 3 s bound held in every case while the wait a person actually experienced was
 * fourteen times it.
 *
 * That is a defect in the PROMISE and not in the door, and it is recorded here because this
 * docblock was rewritten once already to stop making exactly this mistake. `MAX_QUEUED_HASHES` used
 * to carry a wait promise derived from a slot cost measured on an idle machine, and the correction
 * was "a promise measured somewhere else is a hope". A promise measured on the right machine but
 * about a DIFFERENT INTERVAL from the one enforced is the same mistake with the arithmetic hidden,
 * and the table below — which is END-TO-END REQUEST LATENCY, not queue wait — is what made it easy
 * to read this constant as bounding the wrong thing. It is labelled now.
 *
 * THREE SECONDS, which is the 2.7 s the old depth arithmetic claimed and could not keep, rounded up
 * to cover the depth this file actually ships: a full 256-deep queue drains in 2.75 s at the 43 ms
 * slot cost measured here, and a promise a full queue would breach on an idle machine would be the
 * same kind of untrue sentence in a smaller font.
 *
 * A request refused for this reason is the same 429 as one refused for arriving into a full queue,
 * and deliberately so: both are "this server is busy", neither depends on anything about the
 * caller's address or password, and a person cannot act on the difference. `hashGate` sees the two
 * apart in its counters, which is where an operator needs them apart — `shed` says more people
 * arrived than the queue holds, `expired` says this machine is slower than the queue assumed.
 *
 * WHAT IT COSTS, AND IT IS A REAL COST IN ONE SHAPE. MEASURED on this host, ten consecutive member
 * sign-ins during a 1,767 req/s flood. THESE ARE END-TO-END REQUEST TIMES — the thing this constant
 * does not bound — and they are here because they are what the trade is actually about:
 *
 *   deployment shape                        before            after
 *   one tunnel, origins it wrote            182 ms, 10/10     192 ms, 10/10
 *   direct, attacker minting 250 origins    10,680 ms, 10/10  3,221 ms, 2/10
 *
 * The first row is the owner's deployment and nothing about it changed. The second is the residual
 * `hashGate` documents — a shape in which this process has no signal that tells one caller from
 * another — and there the member now meets a refusal where they used to meet a ten-second wait.
 * That is the trade being made rather than a side effect of it: a wait nobody bounded is a dial
 * marked "everybody else's latency" that the attacker holds, which is the sentence the whole gate
 * was built around, and at ten seconds the sign-in was being served to somebody who had almost
 * certainly gone. Refusing after three seconds IN THE QUEUE, with a one-second retry, is the honest
 * version of the same answer, and it returns the CPU to the callers who are still there. It is not
 * a claim that the answer arrives in three seconds; the measurement at the top of this block is
 * what happens when it does not.
 */
const MAX_QUEUE_WAIT_MS = 3_000;

/**
 * What a shed request is told to wait, and it is the honest number rather than a punitive one:
 * nothing was spent, nothing is held against them, and there is no window to sit out — the only
 * reason to wait at all is that the machine is busy this instant. A limiter that says fifteen
 * minutes when it means one second teaches people to ignore it.
 *
 * IT IS A FLOOR RATHER THAN A FORECAST, which is the correction to the sentence that stood here
 * ("the queue in front of them is bounded at 3 s by `MAX_QUEUE_WAIT_MS`, so the true answer is
 * about a second"). `MAX_QUEUE_WAIT_MS` bounds time spent IN THE QUEUE and not the time a request
 * takes; under the flood measured in that constant's docblock a registration took 41 s end to end
 * while the queue bound held. So one second is "you may try again immediately, and there is nothing
 * to serve out", not a prediction that the next attempt will be quick. There is no honest number
 * for that, because it depends on load this process cannot see the end of, and inventing one would
 * be the same class of sentence this file has now corrected three times.
 */
const SHED_RETRY_AFTER_SEC = 1;

/**
 * HOW MANY FAILED SIGN-INS FROM ONE SOURCE NETWORK BEFORE AN OPERATOR IS TOLD, and the number
 * refuses nothing whatsoever.
 *
 * WHY IT EXISTS. MEASURED, 2026-08-09: 2,244 failed sign-ins arriving in twenty-one seconds
 * produced ZERO rows in `audit_log`. The per-`(peer, email)` counter below is the right shape for stopping
 * somebody guessing ONE person's password and is blind by construction to somebody who never
 * guesses the same address twice — and that caller is the one an operator most needs to know
 * about, because they are the one who was making everybody else wait. A control nobody can see
 * operating cannot be operated, and the ones this server already has were all invisible to exactly
 * the traffic that mattered.
 *
 * KEYED ON THE COARSENED TCP PEER, which no header can change. The reported origin would name the
 * actual client network behind a tunnel and is the more useful fact — and is precisely why it is
 * not used: a caller who can write it can hold every bucket below the threshold and be invisible
 * again. An unforgeable key that is sometimes coarse beats a precise one that can be evaded.
 *
 * FIFTY IN FIFTEEN MINUTES. Being wrong about this number costs one audit row per source network
 * per window and nothing else — nobody is refused, delayed, or told anything different — so it is
 * set where a busy campus NAT on results day will occasionally trip it rather than where only an
 * attack will.
 */
const FAILED_SIGN_IN_NOTICE = 50;
const SIGN_IN_NOTICE_WINDOW_MS = 15 * 60 * 1000;

/**
 * How often the expired session rows are cleared out. See `sweepExpiredSessions`, which is the
 * whole of the mechanism and carries the argument for why it hangs off creating a session rather
 * off a timer.
 */
const SESSION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * WHAT A RUNG OF THE REGISTRATION LADDER IS, AND THE ONE RULE ABOUT ITS `noticeKey`.
 *
 * `key` is what the budget counts against and may be a value the caller chose — the connection rung
 * is `req.ip` and that is the point of it. `noticeKey` is what bounds the AUDIT ROW, and it may
 * never be. Those are two different jobs and conflating them is how the old code left the trail
 * floodable: one row per closed budget sounds bounded until the budget's key is a header, at which
 * point a caller rotating that header buys a row per request and buries everything else in the log.
 */
type RungName = 'connection' | 'network' | 'server';

interface Rung {
  readonly name: RungName;
  readonly limiter: RateLimiter;
  readonly key: string;
  /** Derived only from the TCP peer, or from nothing at all. Never from a header. */
  readonly noticeKey: string;
  readonly max: number;
  /**
   * WHO THE REFUSAL SAYS HAS BEEN SIGNING UP — the population this rung's key actually covers on
   * the deployment answering the request, which is not something the rung's NAME can settle. See
   * `rungWhere`.
   */
  readonly where: string;
  /**
   * TRUE WHEN NOTHING THE READER CAN DO CHANGES THIS RUNG'S KEY: it covers every request that
   * reaches this deployment, whatever network or device they come from. It is what earns the
   * sentence that tells them so, and it is a property of the key rather than of the rung's name.
   */
  readonly deploymentWide: boolean;
}

/**
 * WHO THE 429 SAYS HAS BEEN SIGNING UP, AND WHY THE RUNG'S NAME CANNOT ANSWER IT ALONE.
 *
 * The middle rung is keyed on `coarseOrigin(peerAddress(req))`. Behind the owner's Cloudflare
 * tunnel — the documented deployment — the TCP peer is cloudflared, one value for the entire
 * internet, so that key is THE WHOLE DEPLOYMENT and "from your network" is false for everybody who
 * reads it. MEASURED against the built server on this host, 2026-08-12: 130 students registered
 * from one building NAT, an attacker created 270 more from two addresses that were nothing to do
 * with them, and the next student from the building was told "400 accounts have been created from
 * your network in the last fifteen minutes". 130 came from their network. This file already told
 * the OPERATOR the truth in `announceClosedRungs` ("`"rung":"network"` is the WHOLE DEPLOYMENT")
 * while telling the student the pre-tunnel shape.
 *
 * IT IS WORSE THAN AN INACCURACY BECAUSE OF THE ADVICE IT IMPLIES. The justification for naming the
 * rung at all was that "a person who is told 'from this connection' can move or wait". A person
 * told "from your network" reads an instruction to move, and behind the tunnel there is nowhere to
 * move TO: no network they can reach changes that key, and a phone on cellular data lands on the
 * same one. So the sentence has to say which of the two shapes this deployment is, and the
 * deployment-wide case gets the advice that is actually true for it — see `REFUSAL_NOWHERE_ELSE`.
 *
 * HOW THE SHAPE IS TOLD, and it is measured per request rather than configured. `app.ts` sets
 * `trust proxy` to 1, so `req.ip` is the rightmost `X-Forwarded-For` entry when there is one and
 * the socket address when there is not. They differ EXACTLY when something in front of this process
 * wrote that header, which is the same condition that makes the TCP peer a proxy rather than a
 * client. No new configuration, and nothing that can be true of the deployment while being false of
 * the request.
 *
 * WHAT A FORGED HEADER BUYS, said rather than implied: a caller reaching a DIRECT-facing deployment
 * with an `X-Forwarded-For` of their own is told the deployment-wide sentence about a rung that in
 * fact covers only their /24. That is a broader-sounding refusal shown to the one person who forged
 * it and to nobody else — the same trust `req.ip` is already given as the connection rung's key,
 * and the honest reader on such a deployment is unaffected because they send no such header.
 */
function rungWhere(name: RungName, proxied: boolean): string {
  if (name === 'connection') return 'from this connection';
  if (name === 'network') return proxied ? 'on this GrantSpotter' : 'from your network';
  return 'on this GrantSpotter';
}

/**
 * NOT ONE WORD ABOUT HOW LONG, IN ANY OF THE THREE SENTENCES BELOW, AND THAT IS THE 2026-08-12
 * CORRECTION RATHER THAN an oversight.
 *
 * Every refusal this function produces travels with `details.retryAfterSec`, and every client that
 * shows one prints that number: `routes/Enroll.tsx` renders `err.message + " Try again in " +
 * humanRetryAfter(wait) + "."`. So a duration written into the prose is a SECOND statement of the
 * same fact, from a different source, in the same paragraph — and the two disagreed. There is one
 * number, it is `retryAfterSec`, and these sentences say what happened rather than when to come
 * back.
 */
const REFUSAL_SIGN_IN_UNAFFECTED =
  ' If you already have an account, signing in is not affected by this.';

/**
 * THE CLAUSE FOR A RUNG NOBODY CAN WALK AWAY FROM, and it exists because the sentence it is added
 * to used to imply the opposite.
 *
 * It goes on exactly the refusals whose key covers every request the deployment receives — the
 * deployment rung always, and the middle rung whenever this process is behind a proxy, which
 * `rungWhere` explains. For those, "try from somewhere else" is not merely unhelpful, it is a
 * wasted trip: the same key answers a phone on cellular data, a laptop on a different campus, and
 * a different building.
 *
 * SO IT SAYS THE ONE THING THAT IS LEFT TO DO. Waiting is already stated, once, by
 * `details.retryAfterSec` and by nothing else in this paragraph — see the note above on why no
 * refusal here carries a duration. What this adds is the part `retryAfterSec` cannot: that a group
 * arriving together has someone to tell, and that person is whoever runs the deployment, because
 * the ceiling and the window are theirs and not the reader's.
 */
const REFUSAL_NOWHERE_ELSE =
  ' This limit is on the whole of this GrantSpotter rather than on you: every sign-up reaches it ' +
  'the same way, so another network, another device or a phone runs into the same one. If a group ' +
  'is signing up together, whoever runs this GrantSpotter is the person who can change it.';

/**
 * WHY THIS SENTENCE SAYS WHAT IT SAYS, AND WHY THERE ARE THREE OF THEM.
 *
 * The person most likely to read it is the last student in a lecture hall, not an attacker — this
 * rung is on the honest path now, which is the whole difference from the version this replaced. So
 * it says three things: what has actually happened, that nothing about their details is wrong, and
 * that signing in still works, which matters because somebody who already has an account can get in
 * this instant and does not need to wait at all.
 *
 * IT ALSO HAS TO BE TRUE, WHICH IS WHAT THIS FUNCTION HAS NOW GOT WRONG TWICE.
 *
 * THE FIRST TIME it said "Too many accounts have been created … in the last few minutes" and
 * "nothing has been used up", and MEASURED against the built server both were false at once: 120
 * POSTs naming an address that already had an account closed the network rung, and the next student
 * was told accounts had been created while `SELECT COUNT(*) FROM users` returned 1. The fix was to
 * the budget — it counts created accounts now — plus a second sentence for the case where the
 * ceiling is held by work still in flight.
 *
 * THE SECOND TIME WAS THAT SECOND SENTENCE, AND IT SHIPPED FOR A DAY. The branch was
 * `recorded >= rung.max`, where `recorded` came from `RateLimiter.count` — which is RECORDED-ONLY,
 * while the budget is closed by recorded PLUS in-flight. So any spent window with even one
 * registration still running fell through to the burst sentence. MEASURED against the built server
 * on this host, 130 students behind one campus NAT at six submits at a time: 60 created, 70
 * refused, and 37 of the 70 read
 *
 *     "GrantSpotter is already making as many accounts at once as it will from this connection,
 *      so it is not starting another one this second. … wait a moment and try again."
 *
 * in a body carrying `"retryAfterSec":900`, which the sign-up screen renders as "… wait a moment
 * and try again. Try again in 15 minutes." Sixty accounts existed. Nothing was "in flight". Two
 * rounds of review missed it because no test asserted either sentence.
 *
 * SO THE BRANCH IS ON THE NUMBER THE READER IS ABOUT TO BE SHOWN. `RateLimitAttempt` carries
 * `recorded` and `retryAfterSec` out of ONE decision, taken in one synchronous breath, and this
 * function is given both. There is no second read of anything, and no way for the sentence and the
 * number to be about different instants:
 *
 *   NOTHING RECORDED (`recorded === 0`) — the whole budget is held by sign-ups that started and
 *   have not finished. It says exactly that, and it no longer says the reassuring thing, because
 *   THE THIRD TIME THIS FUNCTION WAS WRONG WAS THAT REASSURANCE. It read "No account has been
 *   created from this connection in the last fifteen minutes", which is a claim about a
 *   FIFTEEN-MINUTE WINDOW made at the one instant in that window when it happened to be true, and
 *   the very requests that caused the refusal were guaranteed to falsify it. MEASURED against the
 *   built server on this host, 2026-08-12, 260 students from one building NAT arriving together:
 *   200 created, 56 refused with that sentence — and 200 accounts existed 2.4 s later. A sentence
 *   that its own cause is about to break is not true in the state that produced it, however
 *   carefully the instant is defined, so this branch now states what is HAPPENING (this many
 *   sign-ups are being answered) rather than forecasting what has not.
 *
 *   The wait beside it was wrong in the same breath and is fixed in the limiter rather than here:
 *   `retryAfterSec` was 1 on the reasoning that a budget held by running attempts frees in one
 *   hash, which is true of a limiter counting failures and false of this ladder, whose running
 *   attempts are the successes. See `RateLimiterOptions.counts`.
 *
 *   SOME RECORDED, BELOW THE CEILING — part created, the rest still being answered. Both halves are
 *   named, because "N accounts have been created" alone would understate why the door is shut.
 *
 *   AT OR PAST THE CEILING — the ordinary case, with the count in it so the reader can tell a busy
 *   evening from an attack and so an operator reading a screenshot can match it to the audit row.
 *
 * "NOTHING HAS BEEN USED UP" IS GONE FROM ALL THREE. It was true of the enrollment code this route
 * used to take — the reassurance was "your code is not spent" — and with no code it had drifted
 * into being a claim about the budget, where it was flatly untrue. There is nothing of the reader's
 * to reassure them about any more, so the clause is deleted rather than reworded.
 */
function registrationRefusal(
  rung: Rung,
  outcome: { readonly recorded: number; readonly retryAfterSec: number },
): string {
  const where = rung.where;
  const window = 'in the last fifteen minutes';
  const { recorded } = outcome;
  // The clause for a rung whose key nobody can walk away from, then the one that matters most to
  // somebody who already has an account. Both are appended rather than woven in, so every branch
  // gets them and no branch can be rewritten without them.
  const tail = (rung.deploymentWide ? REFUSAL_NOWHERE_ELSE : '') + REFUSAL_SIGN_IN_UNAFFECTED;

  if (recorded === 0) {
    return (
      `${String(rung.max)} sign-ups ${where} are being answered right now, which is as many as ` +
      'GrantSpotter will start in fifteen minutes, so it is not starting another. The accounts ' +
      'they create count against that same fifteen minutes, so this is not a queue that clears in ' +
      'a moment. Nothing is wrong with your details.' +
      tail
    );
  }
  if (recorded < rung.max) {
    return (
      `${String(recorded)} accounts have been created ${where} ${window}, and the rest of the ` +
      `${String(rung.max)} GrantSpotter will make in that time are requests it is still working ` +
      'on, so it is not starting another. Nothing is wrong with your details.' +
      tail
    );
  }
  return (
    `${String(recorded)} accounts have been created ${where} ${window}, which is as many as ` +
    'GrantSpotter will make in that time, so it is not making another one yet. Nothing is wrong ' +
    'with your details, and the accounts already created are fine.' +
    tail
  );
}

/**
 * THE ONE SENTENCE A TAKEN ADDRESS GETS, AND WHY IT IS THE SPECIFIC ONE FOR EVERYBODY.
 *
 * IT IS AN ACCOUNT-EXISTENCE ORACLE ON AN UNAUTHENTICATED ROUTE AND IT IS UNAVOIDABLE HERE. The
 * previous design rationed this answer per code and made the over-budget caller pay an argon2id to
 * learn the same bit; with open registration there is no unmintable key left to ration against (see
 * `ADDRESS_TAKEN_NOTICE`), and, more fundamentally, "create an account for this address" cannot be
 * answered identically whether or not it can be done. The only way to make a hit and a miss look
 * alike is to refuse the miss — to stop creating accounts — which is the denial this whole route
 * exists to avoid, or to claim an account was created when it was not, which is a lie told to the
 * person it hurts most: somebody who signed up last term, has forgotten, and would then sit at a
 * sign-in screen with a password that was never stored.
 *
 * SO IT SAYS THE USEFUL THING, AND NOTHING BOUNDS THE QUESTION. That is the 2026-08-12 correction
 * to this paragraph, which used to end "what bounds the question is the ladder rather than the
 * wording: a probe is a registration attempt, charged to all three rungs, so asking about an
 * address costs exactly what creating an account costs". It did cost that, and the cost fell on the
 * wrong people: 120 questions closed sign-up for every student behind the tunnel for fifteen
 * minutes, having created nothing. A probe is charged NOTHING now. An attacker can therefore read a
 * club roster against this route as fast as HTTP will carry it — which they could before as well,
 * by reading 429 versus 409 versus 201 instead of reading the sentence, so what the charge actually
 * bought was the denial, not the secrecy.
 *
 * WHAT IS STILL BOUNDED IS THE PART THAT LASTS. Asking about an address that does NOT have an
 * account creates one, and that is a registration, charged to all three rungs — so an attacker
 * working through a roster squats the free addresses at exactly the ceiling on creating accounts
 * and not one faster. `ADDRESS_TAKEN_NOTICE` is what makes somebody working through a list visible
 * to an operator, and visibility is the whole of what is left.
 */
function addressTaken(email: string): string {
  return (
    `${email} already has an account, so nothing was created. Sign in with it instead — an ` +
    'administrator can set a new password if you have forgotten yours.'
  );
}

/**
 * The loser of a genuine race, and only that. Two people registering the same address in the same
 * fifty milliseconds: one gets the account, the other gets this. It carries the same instruction as
 * the sentence above and no fact about anybody, because the caller who reads it may be either of
 * the two and the server found out about the collision after it had committed to creating one.
 */
const CONFLICT_GENERIC =
  'That did not create an account. If the address you gave already has one, sign in with it ' +
  'instead — an administrator can set a new password if you have forgotten yours. Otherwise try ' +
  'again, or with a different address.';

/**
 * WHAT SOMEBODY IS TOLD WHEN THEY REACH A DEPLOYMENT NOBODY HAS SET UP YET, and why registration is
 * shut in that window rather than open.
 *
 * OPEN REGISTRATION AND `userCount() === 0` CANNOT BOTH BE TRUE AT ONCE. `bootstrap.required()` is
 * "no accounts exist", and the first-run token is the only thing that can create an administrator.
 * If a stranger could register on a fresh deployment, their account would make `required()` false
 * and the operator's token would stop working — the instance would be permanently without an
 * administrator, and the only repair would be deleting the database. That is a worse outcome than
 * the land grab it looks like: it is not "somebody else is the admin", it is "nobody can ever be".
 *
 * So the door opens in the order the deployment is built: the token creates the administrator, and
 * the administrator's existence is what opens registration to everybody else. This is also the
 * whole of what an attacker can reach between the container starting and the operator finishing
 * setup — the public corpus, and a bootstrap route that wants 24 random bytes.
 */
const NOT_SET_UP =
  'This GrantSpotter has not been set up yet, so it cannot create accounts. Whoever runs it has ' +
  'to create the administrator account first — once they have, anybody can sign up here.';

/**
 * WHAT A MEMBER AN ADMINISTRATOR HAS SWITCHED OFF IS TOLD, and the reason it is a sentence of its
 * own is at the branch that throws it, in the sign-in handler below.
 *
 * IT SAYS THE PASSWORD IS FINE, EXPLICITLY, because the sentence it replaces sent this reader to
 * reset one that was never wrong — and on this product a reset means asking an administrator, since
 * there is no reset mail (`README`: no SMTP). It names who can undo it for the same reason: this is
 * the one refusal on either of these routes that the reader genuinely cannot act on alone.
 */
const ACCOUNT_DISABLED =
  'That account has been switched off by an administrator, so GrantSpotter will not sign it in. ' +
  'Your password is correct and there is nothing wrong with it — changing it would not help. ' +
  'Ask whoever runs this GrantSpotter to switch the account back on.';

/**
 * Somebody registered with an address that already has an account, and the transaction had already
 * started when we found out.
 *
 * THERE ARE TWO CHECKS FOR ONE CONDITION, and the second is not a duplicate of the first. The
 * handler reads `findByEmail` up front, before the hash, because that is where the person who
 * simply forgot they had signed up gets the answer that helps them, and getting it before the hash
 * is what makes it cheap for the server as well as fast for them. This one is inside the
 * transaction, where nothing can run between it and the INSERT, and it is the one that is
 * AUTHORITATIVE: the early read is stale the instant it returns, and only a check that sits in the
 * same synchronous stretch as the write can promise that two people registering the same address in
 * the same fifty milliseconds do not both get an account.
 *
 * `adminUsersRouter.ts` needs a pre-check AND a catch of the raw SQLite unique-constraint error,
 * and the difference is instructive rather than an inconsistency: that route awaits argon2 between
 * its check and its write, so its check really can go stale and the constraint really is its last
 * line. The check that matters here cannot — nothing runs between it and the INSERT — so the
 * constraint is a backstop that no ordering of requests can reach.
 */
class DuplicateEmailError extends Error {
  constructor() {
    super('duplicate email');
    this.name = 'DuplicateEmailError';
  }
}

/**
 * A 429 THAT SAYS HOW LONG IN THE PLACE THE PROTOCOL PUTS IT, AND NOT ONLY IN THE PROSE.
 *
 * MEASURED on this host, 2026-08-12, against the built server: every 429 from
 * `POST /api/auth/enroll` and `POST /api/auth/login` answered `retry-after: undefined`. The number
 * was in `error.details.retryAfterSec` and nowhere else, so the only caller that could act on it
 * was one that had been written against this project's own envelope. These two were ALONE among
 * this server's rate-limited routes in that: `api/verifyRouter.ts`, `api/exports.ts` and
 * `api/callsign.ts` all set the header, all with the same one-line comment, and all keep the body
 * envelope unchanged. RFC 9110 §10.2.3 makes `Retry-After` the interoperable answer to a 429 — it
 * is what an HTTP client library, a monitoring probe, a `curl` script or a reverse proxy reads —
 * and the two routes that omitted it are the two an unauthenticated stranger can reach.
 *
 * THE FUNCTION RETURNS THE ERROR RATHER THAN THROWING IT so the call site still reads `throw`,
 * which is what keeps TypeScript's control flow analysis (and a reader's) able to see that nothing
 * after it runs. `api/exports.ts` uses the same shape for the same reason.
 */
function refuseWithRetryAfter(res: Response, message: string, retryAfterSec: number): AppError {
  res.setHeader('Retry-After', String(retryAfterSec));
  return new AppError('rate_limited', message, { retryAfterSec });
}

/**
 * THE CALLER, AS THE DEPLOYMENT'S OWN PROXY REPORTS THEM — the key for anything rationed per
 * caller rather than per credential.
 *
 * `app.ts` sets `trust proxy` to 1, so express takes the RIGHTMOST entry of `X-Forwarded-For`: the
 * one the single hop in front of this process wrote, not one a client can prepend. That is
 * trustworthy exactly when the documented deployment shape holds (one reverse proxy or tunnel) and
 * is chosen by the client when it does not. Every use of this value carries a comment saying which
 * of those two it is relying on.
 *
 * IT IS NEVER THE ONLY THING BETWEEN A CALLER AND SOMETHING THEY WANT. That was true of the
 * enrolment guess budget until 2026-08-10 and was the whole of the defect: a value the caller
 * writes is a fine way to tell honest callers apart and is not a limit. Where it appears now it is
 * the narrowest rung of a ladder whose lower rungs are the TCP peer and nothing at all, or it is a
 * detail in a row bounded by one of those.
 */
function reportedOrigin(req: Request): string {
  return req.ip === undefined || req.ip === '' ? 'unknown' : req.ip;
}

/**
 * THE CALLER'S TCP PEER, which no header can change and no client can choose.
 *
 * Behind a reverse proxy this is the proxy, one value for everybody — useless for telling two
 * clients apart and unforgeable. It is used where the cost of a forgeable key would be real
 * (sign-in, below) and `reportedOrigin` is used where the cost of a fixed key would be worse.
 */
function peerAddress(req: Request): string {
  const raw = req.socket.remoteAddress;
  return raw === undefined || raw === '' ? 'unknown' : raw;
}

export function createAuthRouter(deps: AuthRouterDeps): Router {
  const users = createUserRepo(deps.db);
  const sessions = createSessionRepo(deps.db);
  /**
   * ALL THREE RUNGS COUNT SUCCESSES, and saying so is what makes the wait they quote true.
   *
   * `counts: 'successes'` is not a description of these limiters, it is the fact the limiter needs
   * in order to answer "when does a slot free?" while the budget is held by sign-ups still running.
   * On a failure budget those slots come back within one hash; on this ladder they become created
   * accounts and hold for the window, which is why the burst branch answered 1 second to 56 of 260
   * students who then met a 897-second refusal. See `RateLimiterOptions.counts`.
   *
   * A `registrationLimiter` INJECTED FROM OUTSIDE MUST SAY IT TOO. Nothing in this server injects
   * one today; the option is here for a test that wants a tiny window, and a tiny window with the
   * default 'failures' would reproduce the exact defect this line exists to close.
   */
  const connectionLimiter =
    deps.registrationLimiter ??
    createRateLimiter({
      windowMs: REGISTRATION_WINDOW_MS,
      maxFailures: REGISTRATION_MAX_PER_CONNECTION,
      counts: 'successes',
    });
  /**
   * THE TWO RUNGS BELOW THE CONNECTION, AND WHY NEITHER IS INJECTABLE.
   *
   * `registrationLimiter` is a dependency because a test wanted a tiny window without editing
   * `app.ts`; these are not. Their numbers are reachable in the tests that matter (400 and 800
   * requests), and a limiter a deployment can weaken from outside is a limiter whose comment stops
   * being true of the thing that ships. See `REGISTRATION_WINDOW_MS` above for what each rung costs
   * and what it buys.
   *
   * Both hold at most their own ceiling in timestamps — a rung that refuses records nothing — so
   * neither grows the way the `ThresholdNotice` comment warns an unbounded `createRateLimiter`
   * does.
   */
  const networkLimiter = createRateLimiter({
    windowMs: REGISTRATION_WINDOW_MS,
    maxFailures: REGISTRATION_MAX_PER_NETWORK,
    counts: 'successes',
  });
  const deploymentLimiter = createRateLimiter({
    windowMs: REGISTRATION_WINDOW_MS,
    maxFailures: REGISTRATION_MAX_DEPLOYMENT,
    counts: 'successes',
  });
  /**
   * THE RUNGS IN THE ORDER THEY ARE ASKED, NARROWEST FIRST, and the order is load-bearing twice
   * over: the narrowest rung gives the most useful sentence when it is the one that fires, and —
   * because a refusal charges nothing — being refused narrowly is what stops one caller spending
   * the coarse budgets that everybody else shares.
   */
  function registrationRungs(req: Request): Rung[] {
    const network = coarseOrigin(peerAddress(req));
    /**
     * IS THERE A HOP IN FRONT OF THIS PROCESS? `trust proxy` is 1, so `req.ip` follows the rightmost
     * `X-Forwarded-For` when one is present and is the socket address when it is not. They differ
     * exactly when something wrote that header — which is what makes the TCP peer a proxy, and the
     * middle rung's key everybody rather than one network. `rungWhere` carries the whole argument,
     * including what a forged header does and does not buy.
     */
    const proxied = reportedOrigin(req) !== peerAddress(req);
    return [
      {
        name: 'connection',
        limiter: connectionLimiter,
        key: reportedOrigin(req),
        // NOT the origin, which is the key: the row has to be bounded by something the caller
        // cannot mint, or the trail is the attacker's to fill.
        noticeKey: `registration:connection:${network}`,
        max: REGISTRATION_MAX_PER_CONNECTION,
        where: rungWhere('connection', proxied),
        // The one rung a reader can walk away from: behind the tunnel its key is what cloudflared
        // reported, so a phone on cellular data really is a different connection.
        deploymentWide: false,
      },
      {
        name: 'network',
        limiter: networkLimiter,
        key: network,
        noticeKey: `registration:network:${network}`,
        max: REGISTRATION_MAX_PER_NETWORK,
        where: rungWhere('network', proxied),
        deploymentWide: proxied,
      },
      {
        name: 'server',
        limiter: deploymentLimiter,
        key: DEPLOYMENT_KEY,
        noticeKey: 'registration:server',
        max: REGISTRATION_MAX_DEPLOYMENT,
        where: rungWhere('server', proxied),
        // One key for the process, on every deployment shape there is.
        deploymentWide: true,
      },
    ];
  }
  /**
   * Never consulted before answering anybody and never able to refuse: it exists so that somebody
   * working through a list of addresses leaves a mark. See `ADDRESS_TAKEN_NOTICE`.
   */
  const takenNotice = createThresholdNotice({
    windowMs: REGISTRATION_WINDOW_MS,
    threshold: ADDRESS_TAKEN_NOTICE,
  });
  /**
   * ONE GATE FOR BOTH ROUTES, because there is one CPU. Sign-in and registration are the only two
   * unauthenticated paths in this server that run argon2id, and a ceiling that either of them could
   * exceed by borrowing the other's headroom would not be a ceiling.
   *
   * THE 2026-08-11 CHANGE MADE THIS MORE LOAD-BEARING, NOT LESS. The route it protects used to
   * demand a credential before it hashed anything, so the flood it had to survive was somebody
   * else's; now anybody can ask this process for an argon2id hash by POSTing a sign-up form, and
   * the direction the starvation runs in is the one this gate was built for in reverse. The
   * property that has to hold is that a burst of registrations cannot make a member wait to sign
   * in, and it holds for the same reason it held the other way round: the round is between CALLERS
   * and cuts across both routes, so the flood is one lane whatever it is aimed at.
   *
   * SPLITTING IT PER ROUTE WAS THE OBVIOUS FIX AND IS STILL THE WRONG ONE, AND ON 2026-08-12 THE
   * ROUND LEARNED THE ROUTE ANYWAY. Those are not the same thing and the difference is the point.
   * Two gates would give each route its own ceiling on concurrent hashes, so the process could run
   * eight at once — there is one CPU and `MAX_CONCURRENT_HASHES` is a claim about it, so a ceiling
   * either route could exceed by borrowing the other's headroom is not a ceiling. It would also
   * leave the same stranger able to make every MEMBER of the deployment wait five seconds to sign
   * in, which is the larger population and the more important route.
   *
   * What was missing was not a second gate but a level in the ROUND. MEASURED, and it is why this
   * paragraph is being rewritten rather than defended: a 1,642 req/s sign-in flood shed 83 of 130
   * students out of a queue they were entitled to a share of, because "one queue, turns taken
   * between callers" says nothing about two routes when the flood is one caller on one of them and
   * the students are a hundred and thirty on the other. The routes take turns now, inside the peer
   * and above the origin, so the CPU is still one ceiling and neither route can spend the other's
   * half of it. `QueueLane` carries the ordering argument.
   *
   * MEASURED, 2026-08-09, 512 connections rotating the email on `/api/auth/login` against a server
   * in its own process, with one student enrolling throughout. Three deployment shapes, because
   * the two halves of a lane are trustworthy in different ones:
   *
   *   shape                                   student's enrolment      audit rows
   *   one proxy in front (documented)         5,036 ms -> 330 ms       0 -> 2
   *   no proxy, attacker forges the header    5,133 ms -> 302 ms       0 -> 2
   *   one proxy AND a caller-chosen req.ip    5,070 ms -> 4,065 ms     0 -> 2
   *
   * Nothing legitimate was refused in any of the three, before or after: the enrolment was answered
   * 201 every time, and what changed is how long it took.
   *
   * THE THIRD ROW IS THE RESIDUAL AND IT IS STATED RATHER THAN ROUNDED OFF. It is a deployment in
   * which every caller shares one TCP peer AND `req.ip` is a value the caller writes — a proxy that
   * does not append `X-Forwarded-For`, or `trust proxy` set to more hops than there really are. In
   * that shape this process has no signal at all that distinguishes one caller from another, so no
   * scheduler could divide anything fairly and this one does not pretend to. What it still does is
   * bound the damage: the wait stops growing with the attacker's connection count and settles at
   * the queue's own drain time. The fix for that row is configuration, not code.
   */
  const hashGate = createConcurrencyGate({
    maxConcurrent: MAX_CONCURRENT_HASHES,
    maxQueued: MAX_QUEUED_HASHES,
    maxWaitMs: MAX_QUEUE_WAIT_MS,
  });
  /**
   * Never consulted before answering anybody and never able to refuse: it exists so that the
   * traffic the counters above are blind to leaves a mark. See `FAILED_SIGN_IN_NOTICE`.
   */
  const signInNotice = createThresholdNotice({
    windowMs: SIGN_IN_NOTICE_WINDOW_MS,
    threshold: FAILED_SIGN_IN_NOTICE,
  });

  /**
   * ONE ROW PER KEY PER WINDOW, and no more, for a thing that is happening to the deployment rather
   * than to a record in it.
   *
   * WHY IT EXISTS. Until 2026-08-05 a stranger could close self-enrolment for every club on the
   * instance with ten requests and the `audit_log` was EMPTY afterwards: the operator saw a page
   * refusing everybody with no record of when it started, roughly where from, or that a limiter was
   * involved at all. A control whose operation is invisible cannot be operated. That matters more
   * now than it did then: with registration open, the rung that closes is refusing people the
   * product wants, and the row is how an operator finds out that it happened at all.
   *
   * WHY IT IS BOUNDED. The row is written by the request that CLOSES a budget, never by the ones
   * refused afterwards, so a caller who keeps knocking writes one row per fifteen minutes rather
   * than one per request — an audit trail an attacker can fill at will is an audit trail that hides
   * everything else in it.
   *
   * AND THE KEY MUST BE ONE THE CALLER CANNOT MINT, which is a rule this function cannot enforce
   * and every call site now keeps. "One row per key per window" is only a bound when the number of
   * keys is; until 2026-08-10 two of the three keys here contained `req.ip`, so a caller rotating
   * that header could write a row every ten requests, growing this map without limit and burying
   * everything else in the log. Every key below is derived from the TCP peer, or from nothing.
   */
  const announced = new Map<string, number>();
  function announceOnce(key: string, row: Parameters<typeof appendAuditLog>[1]): void {
    const nowMs = Date.now();
    const last = announced.get(key);
    if (last !== undefined && nowMs - last < REGISTRATION_WINDOW_MS) return;
    // Swept here rather than on a timer: the map is only ever read on this path, so the only moment
    // a stale entry costs anything is the moment we are already looking at it. Without this a
    // caller rotating the key would grow it without bound, which is the memory version of the
    // unbounded audit trail this function exists to prevent.
    for (const [seen, at] of announced) {
      if (nowMs - at >= REGISTRATION_WINDOW_MS) announced.delete(seen);
    }
    announced.set(key, nowMs);
    appendAuditLog(deps.db, row);
  }

  /**
   * THE ROW AN OPERATOR READS WHEN SIGN-UP STOPS WORKING, written by the registration that filled
   * the last place in a rung and by no other request.
   *
   * An operator who finds sign-up refusing people needs to see that a limiter did it, which one,
   * and roughly where from; `coarseOrigin` keeps that to a /24 or a /48, because an audit row
   * outlives the incident. Never an address: the reported origin is in the detail as a sample
   * rather than as the subject, because on the rung it matters for it IS the subject and on the
   * others it is whatever the last forger happened to write.
   *
   * THIS ROW IS NOT ONLY AN ALARM. Registration closing is a thing that happens to legitimate
   * visitors, so the row may be the only evidence that thirty people were turned away — which is
   * why it carries the ceiling and the window as well as the rung, so the reader can tell "an
   * attack reached the deployment ceiling" from "one lecture hall signed up two hundred times this
   * afternoon".
   *
   * HOW TO READ `rung` BEHIND A TUNNEL, because it is not obvious from the name and this row is
   * where an operator meets it. `"rung":"connection"` is ONE BUILDING — the public address
   * cloudflared reported — and it means that room has made its 200 for the quarter of an hour;
   * everybody else is unaffected. `"rung":"network"` is the WHOLE DEPLOYMENT, because every request
   * arrives on one TCP peer, and it means sign-up is shut for everyone until the window rolls.
   * `"rung":"server"` cannot appear behind a tunnel at all: it sits under a rung that is already
   * deployment-wide. `REGISTRATION_WINDOW_MS` states the ceilings in plain words and the README
   * repeats them.
   *
   * `registrations` IS THE COUNT THAT WAS ACTUALLY RECORDED, NOT THE CEILING. It used to be
   * `rung.max`, which is a constant and therefore says nothing, and on 2026-08-12 it was MEASURED
   * saying something false: `{"rung":"network","registrations":120}` on a deployment where
   * `SELECT COUNT(*) FROM users` returned 1, because the budget had been spent by 120 probes that
   * created nothing. The budget counts created accounts now, and this row quotes the count.
   */
  function announceClosedRungs(
    req: Request,
    charged: ReadonlyArray<{ rung: Rung }>,
    atISO: string,
  ): void {
    const reported = coarseOrigin(reportedOrigin(req));
    for (const { rung } of charged) {
      // RECORDED AT THE CEILING, not `check`. `check` also counts registrations still in flight, so
      // it goes false for the few tens of milliseconds a burst of argon2id takes and would write a
      // row saying a rung closed at 43 of 60 — which is true of the budget and not of the sentence
      // "this many accounts have been created". A row is written when the ceiling is genuinely
      // spent in rows that exist; the transient is real, it refuses people for one hash, and the
      // sentence they are shown says so in its own words rather than by pretending to be this one.
      const recorded = rung.limiter.count(rung.key);
      if (recorded < rung.max) continue;
      announceOnce(rung.noticeKey, {
        userId: null,
        action: 'auth.registration_limited',
        entityType: 'auth',
        entityId: rung.name === 'server' ? DEPLOYMENT_KEY : coarseOrigin(peerAddress(req)),
        detail: JSON.stringify({
          rung: rung.name,
          reportedOrigin: reported,
          registrations: recorded,
          ceiling: rung.max,
          windowSec: REGISTRATION_WINDOW_MS / 1000,
        }),
        atISO,
      });
    }
  }

  /**
   * THE ONE PLACE EITHER UNAUTHENTICATED ROUTE RUNS argon2id, and the only place that knows what a
   * shed looks like to a person.
   *
   * The lane is the three values the gate takes turns over: the TCP peer, which nobody can forge;
   * the route, which this server writes; and the address our own proxy reported, which tells two
   * users of one tunnel apart. No one of them is trustworthy alone and `QueueLane` says why the
   * round is nested over all three, in that order.
   *
   * A SHED IS A 429 AND NOT A 500, because it is a true statement about capacity rather than a
   * fault, and it is deliberately the same 429 on both routes and for every caller: it depends on
   * queue occupancy and on nothing about the address or the password, so it cannot be used to tell
   * either of those apart. No argon2id has run when it is thrown, so retrying costs the caller
   * nothing but the wait — AND, since 2026-08-12, nothing else either. The registration rungs used
   * to have been charged by the time a request reached this gate, and the comment here called that
   * deliberate; it meant a sign-in flood could spend the sign-up budget through the shared queue,
   * measured at 83 of 130 students. The route releases its slots on this path now.
   *
   * `route` IS PASSED BY THE CALLER AND IS NOT DERIVED FROM THE REQUEST. Two constants, at two call
   * sites, so there is no parsing of a path to get it wrong and nothing a caller can send that puts
   * them in the other route's share of the round. See `QueueLane`.
   */
  async function hashUnderGate<T>(
    req: Request,
    res: Response,
    route: HashRoute,
    work: () => Promise<T>,
  ): Promise<T> {
    const peer = peerAddress(req);
    const origin = reportedOrigin(req);
    try {
      return await hashGate.run({ peer, route, origin }, work);
    } catch (err) {
      if (!(err instanceof QueueFullError)) throw err;
      // One row per source per window, by the same rule the other announcements follow: the caller
      // being shed is by definition the one sending the most, and a row per shed request would be
      // an audit trail they could fill at will. Coarsened, because this row outlives the incident.
      //
      // THE KEY IS THE PEER ALONE. It used to be `peer|origin`, which meant a caller writing their
      // own `X-Forwarded-For` had 2^24 keys to rotate through and so one row per shed request after
      // all — the bound was written down and then handed to the attacker. The reported origin is
      // still in the detail, where being caller-chosen costs nothing.
      announceOnce(`shed:${coarseOrigin(peer)}`, {
        userId: null,
        action: 'auth.hash_queue_shed',
        entityType: 'auth',
        entityId: coarseOrigin(peer),
        detail: JSON.stringify({
          reportedOrigin: coarseOrigin(origin),
          maxQueued: MAX_QUEUED_HASHES,
          maxConcurrent: MAX_CONCURRENT_HASHES,
        }),
        atISO: new Date().toISOString(),
      });
      // NOT ONE WORD ABOUT HOW LONG, by the rule the registration refusals follow and for the same
      // reason: `SHED_RETRY_AFTER_SEC` travels with this in `details.retryAfterSec`, and both
      // screens now print the server's sentence and then that number. "wait a moment and try
      // again" stood here until 2026-08-12 and produced "… nobody needs to do anything about it —
      // wait a moment and try again. Try again in 1 second." — one paragraph, two statements of
      // when, from two sources. There is one, and it is the number.
      throw refuseWithRetryAfter(
        res,
        'This server is already doing as much password checking as it can right now. Nothing is ' +
          'wrong with your details, nothing has been used up, and nobody needs to do anything ' +
          'about it.',
        SHED_RETRY_AFTER_SEC,
      );
    }
  }

  const router = Router();

  /**
   * WHEN THE EXPIRED SESSION ROWS GO, AND WHY IT IS AMORTISED HERE RATHER THAN ON A TIMER.
   *
   * `sessions.removeExpired` HAD NO CALLER ANYWHERE IN THIS SERVER — it was written, tested in
   * `test/accounts.test.ts`, and never invoked, so a session row lived its full thirty days and
   * then stayed for good. MEASURED on 2026-08-12: a registration writes THREE rows, not two —
   * `users`, `audit_log` and `sessions`, because signing up signs you in — and 100 registrations
   * produced 101 sessions rows, none of which anything would ever have removed. A mass
   * registration's rows are the ones an administrator deletes; its SESSIONS are the ones nobody
   * even knew were there.
   *
   * ON THIS PATH BECAUSE THIS PATH IS WHAT GROWS THE TABLE. A timer would sweep a server nobody is
   * using, which is the one state in which there is nothing to sweep; creating a session is the
   * only thing that adds a row, so the cheapest correct place to remove the dead ones is just
   * before adding a live one. HOURLY, so a burst of a hundred sign-ins does one DELETE and not a
   * hundred, and so the first sign-in after a restart clears whatever the last run left behind.
   *
   * A DELETE that matches nothing on a table with no expired rows is what this costs on the
   * ordinary day: one statement an hour.
   */
  let sessionsSweptAtMs = 0;
  function sweepExpiredSessions(): void {
    const nowMs = Date.now();
    if (sessionsSweptAtMs !== 0 && nowMs - sessionsSweptAtMs < SESSION_SWEEP_INTERVAL_MS) return;
    sessionsSweptAtMs = nowMs;
    sessions.removeExpired(new Date(nowMs).toISOString());
  }

  function startSession(req: Request, res: Response, userId: string): void {
    sweepExpiredSessions();
    const rawId = newSessionId();
    sessions.create({
      id: sessionIdHash(rawId),
      userId,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
      userAgent: (req.header('user-agent') ?? '').slice(0, 255),
    });
    res.cookie(
      SESSION_COOKIE,
      signSessionCookie(rawId, deps.config.sessionSecret),
      sessionCookieOptions(req),
    );
  }

  router.get('/auth/bootstrap-status', (_req, res) => {
    res.json({ required: deps.bootstrap.required() });
  });

  router.post(
    '/auth/bootstrap',
    asyncHandler(async (req, res) => {
      const body = bootstrapSchema.parse(req.body);

      if (!deps.bootstrap.required()) {
        throw new AppError('conflict', 'An account already exists; bootstrap is closed.');
      }

      // The password is checked BEFORE the token is consumed, and the order is the
      // whole point. `consume` sets the one-time token to null on a match, so when
      // this ran after it, an operator who typed a short password got a 422 telling
      // them to pick a longer one — and the token they had just copied out of
      // `docker logs` was already spent. Every retry, correct token and good password,
      // then answered 401 "That bootstrap token is not valid", while bootstrap-status
      // went on reporting `required: true` and the first-run screen went on inviting
      // them to try. Restarting the container to mint a fresh token was the only way
      // in. A rejected body must cost the operator nothing; the token is spent only by
      // an attempt that would otherwise have created the account.
      try {
        assertPasswordPolicy(body.password);
      } catch (err) {
        if (err instanceof WeakPasswordError) {
          throw new AppError('validation_failed', err.message);
        }
        throw err;
      }

      if (!deps.bootstrap.consume(body.token)) {
        throw new AppError('unauthorized', 'That bootstrap token is not valid.');
      }

      const user = users.create({
        email: body.email,
        passwordHash: await hashPassword(body.password),
        role: 'admin',
        ...(body.displayName === undefined ? {} : { displayName: body.displayName }),
      });

      /*
        `syncEnvEnrollmentCode` WAS CALLED HERE AND IS GONE (2026-08-11). It turned the
        `ENROLLMENT_CODE` an operator had written in `docker-compose.yml` into a redeemable row,
        attributed to the administrator created two statements above — the only moment on a fresh
        database when there was anybody to attribute it to. There is no such variable and no such
        row now; registration is open, and it opens at exactly this instant, because `users.create`
        above is what makes `bootstrap.required()` false and that is what the registration route
        waits for. The sequencing the deleted call needed is the sequencing that is left.
      */
      startSession(req, res, user.id);
      res.status(201).json({ user: toPublicUser(user) });
    }),
  );

  /*
    `GET /auth/enrollment-open` WAS HERE AND IS GONE (2026-08-11). It answered one boolean — is
    there a live enrollment code — so the sign-in screen could decide whether to offer a way in
    that would work. Registration is open now, so the honest answer would be a constant, and a
    route that returns a constant is a question the browser should not be asking. The sign-in
    screen offers sign-up unconditionally; `routes/Login.tsx` says why that is the same decision
    written on the other side of the wire.

    A browser tab left open across the upgrade will still ask, get the 404 that any unknown /api
    path gets, and treat it as "did not say" — which its own comment already said leaves the offer
    standing. Nothing about that path breaks.
  */

  /**
   * REGISTRATION. The route keeps its `/auth/enroll` path and no longer keeps its meaning: it takes
   * an email, a password and an optional display name, and it creates a member account for
   * anybody who asks.
   *
   * WHY THE PATH DID NOT CHANGE WITH THE MEANING. `/auth/register` reads better and would have cost
   * a coordinated edit across the browser bundle, the e2e specs and two test files owned by other
   * work in flight, for no property. It also would have broken exactly one caller that matters: a
   * browser holding the OLD sign-up form, which posts here with a `code` the schema now strips.
   * That tab still works. The name is the last thing in this file that still says "enroll", and it
   * is documented rather than corrected because a rename is a separate, mechanical change.
   */
  router.post(
    '/auth/enroll',
    asyncHandler(async (req, res) => {
      const body = registrationSchema.parse(req.body);

      const nowISO = new Date().toISOString();

      /**
       * THE PASSWORD FLOOR FIRST, BEFORE ANYTHING THAT DEPENDS ON THE ADDRESS, and this ordering is
       * a security property rather than a matter of taste.
       *
       * MEASURED, 2026-08-05, with the floor checked after the address: a ONE-CHARACTER password
       * answered 409 "<address> already has an account" for a member and 422 "Password must be at
       * least 12 characters." for anybody else — and the 422 was charged to no budget, written to
       * no log and cost no argon2id. 2,000 addresses were classified in 2,983 ms, which is 2.4
       * million an hour, with nothing created and nothing spent. The route's own sign-up screen
       * checks this floor before it POSTs, so that branch was unreachable from the product and
       * existed only for somebody using it as a directory.
       *
       * A cheap invalid input must never be able to separate two answers that the design has
       * decided are worth separating expensively. This check depends on nothing but the password:
       * it answers identically for a member and for a stranger, so it cannot be used to tell them
       * apart. It charges nothing for the same reason — a caller learns nothing by reaching it.
       */
      try {
        assertPasswordPolicy(body.password);
      } catch (err) {
        if (err instanceof WeakPasswordError) {
          throw new AppError('validation_failed', err.message);
        }
        throw err;
      }

      /**
       * NOBODY REGISTERS BEFORE THE ADMINISTRATOR EXISTS. See `NOT_SET_UP` for the argument: this
       * is not a race against a land grab, it is the line that stops a stranger's account making
       * the operator's one-time token useless forever.
       *
       * Charged to nothing, for the same reason as the floor above: the answer depends on the state
       * of the deployment and on nothing about the caller or the address, so it separates nobody
       * from anybody. It is also reachable exactly once per deployment lifetime — the moment the
       * first administrator exists, this branch is dead for good.
       */
      if (deps.bootstrap.required()) {
        throw new AppError('conflict', NOT_SET_UP);
      }

      /**
       * THE LADDER, SECOND. A SLOT IS TAKEN HERE AND BECOMES A RECORDED REGISTRATION ONLY WHEN AN
       * ACCOUNT EXISTS.
       *
       * WHAT CHANGED HERE ON 2026-08-11 IS WHICH REQUESTS ARRIVE. This block used to sit on the
       * "that code is not valid" branch, where only a guesser ever reached it; it now sits on the
       * path of every registration, honest or not, because with no code there is no branch that
       * separates the two.
       *
       * WHAT CHANGED ON 2026-08-12 IS WHICH REQUESTS PAY. `recordFailure` stood here, charging
       * every arrival before anybody knew what it would turn into, and three of the four things a
       * request can turn into create nothing at all: a taken address, a shed request, the loser of
       * a race. MEASURED, 120 of the first kind shut sign-up for a whole tunnel in 147 ms having
       * created nothing, and 83 of the second kind did it during a sign-in flood. `begin` claims
       * the slot in the same breath as it reads the budget — so a burst still cannot walk past a
       * counter none of it has paid into — and the slot is released, unrecorded, by every path
       * below except the one that returns from `users.create`. See `REGISTRATION_WINDOW_MS`.
       *
       * BEFORE THE HASH, so a burst of registrations cannot start an unbounded number of argon2id
       * operations. No `await` anywhere between the read and the claim, so two hundred requests
       * arriving together are counted as two hundred rather than as one.
       */
      const rungs = registrationRungs(req);
      const held: Array<{ rung: Rung; attempt: Extract<RateLimitAttempt, { started: true }> }> = [];
      let stopped: { rung: Rung; recorded: number; retryAfterSec: number } | undefined;
      for (const rung of rungs) {
        const attempt = rung.limiter.begin(rung.key);
        if (!attempt.started) {
          // BOTH NUMBERS, OUT OF THE ONE DECISION THAT REFUSED. The sentence and the wait have to
          // describe the same instant; reading the count back off the limiter afterwards is what
          // told 37 of 130 students that nothing had been created while sixty rows existed. See
          // `registrationRefusal`.
          stopped = { rung, recorded: attempt.recorded, retryAfterSec: attempt.retryAfterSec };
          break;
        }
        held.push({ rung, attempt });
      }

      if (stopped !== undefined) {
        // NOTHING IS CHARGED WHEN A RUNG REFUSES, and it is the property the ratio between the
        // rungs depends on: a caller who has been cut off cannot go on spending the budgets shared
        // with everybody else, cannot extend their own sliding window by knocking, and cannot add
        // a key to any of these maps. The rungs ABOVE the one that refused give their slots back
        // here for the same reason — a request that is not going to create an account must not
        // hold a place in the budget for ones that would.
        for (const { attempt } of held) attempt.release();
        // Retry-After is a transport header; the body stays the one error envelope. See
        // `refuseWithRetryAfter`.
        throw refuseWithRetryAfter(
          res,
          registrationRefusal(stopped.rung, stopped),
          stopped.retryAfterSec,
        );
      }

      try {
        /**
         * THE ADDRESS, THIRD, AND THE ANSWER IS THE USEFUL ONE FOR EVERYBODY WHO REACHES IT.
         *
         * `addressTaken` carries the argument for why this cannot be made indistinguishable from a
         * miss, and why the answer is no longer rationed. What it costs the server is one indexed
         * read, deliberately BEFORE the hash, because the person who meets this most often is
         * somebody who signed up last term and forgot, and making them wait 50 ms for the argon2id
         * they were never going to need buys nobody anything. What it costs everybody else is now
         * nothing at all: the `finally` below gives this request's three slots back, because it
         * created no account and the budget counts accounts.
         *
         * The notice is counted here rather than at the answer below so that the race-loser path,
         * which is a genuine collision and not a question, does not inflate it.
         */
        if (users.findByEmail(body.email) !== undefined) {
          const coarsePeer = coarseOrigin(peerAddress(req));
          const answers = takenNotice.announce(coarsePeer);
          if (answers > 0) {
            // A ROW THAT NAMES A SOURCE NETWORK AND A COUNT — never an address, and never how
            // many DISTINCT addresses were asked about. The second would be the more useful signal
            // and it is also a list of who was asked about, kept for longer and read by more people
            // than the answers were. Same rule as `auth.failed_sign_ins`, which is the same shape
            // of fact about the same kind of caller.
            //
            // THIS ROW IS THE WHOLE OF WHAT AN OPERATOR GETS ABOUT SOMEBODY READING A ROSTER, which
            // it was not on 2026-08-11: the ladder was also refusing them after a few hundred
            // questions. It no longer is, deliberately, so this is not a supporting signal any more
            // — it is the signal. Which is exactly why `answers` had to stop being a constant.
            //
            // `answers` IS THE NUMBER OF ANSWERS. It was `ADDRESS_TAKEN_NOTICE`, the threshold, and
            // MEASURED against the built server on this host that produced the operator's entire
            // record of 4,000 probes in 2.4 s: one row reading `{"answers":20,"windowSec":900}`. A
            // field named for a quantity must hold that quantity — the defect this file had already
            // fixed one function above, in `announceClosedRungs`, on the same day.
            // `ThresholdNotice.announce` re-announces at each doubling (20, 40, 80, …), so a reader
            // gets the ORDER OF MAGNITUDE — the only thing that separates a club intake from
            // somebody working through a roster — in a number of rows that grows logarithmically
            // and cannot be used to bury the rest of the trail.
            appendAuditLog(deps.db, {
              userId: null,
              action: 'auth.addresses_probed',
              entityType: 'auth',
              entityId: coarsePeer,
              detail: JSON.stringify({
                answers,
                threshold: ADDRESS_TAKEN_NOTICE,
                windowSec: REGISTRATION_WINDOW_MS / 1000,
              }),
              atISO: nowISO,
            });
          }
          throw new AppError('conflict', addressTaken(body.email));
        }

        /**
         * OUTSIDE THE TRANSACTION, AND INSIDE THE GATE.
         *
         * Outside the transaction because argon2id is tens of milliseconds of real work and the
         * only `await` on this path; it is precisely the window in which two people registering the
         * same address overlap. Doing it here means the transaction below contains no `await` at
         * all, so nothing can run between the check and the INSERT.
         *
         * Inside the gate because this is the expensive thing, and the expensive thing is what
         * wants bounding. The gate QUEUES: thirty students pressing submit together all get
         * accounts, four hashes at a time. What used to stand here was a failure budget claiming a
         * slot for every attempt including the successful ones, and it answered twenty of those
         * thirty students "Too many enrollment attempts. Try again later."
         *
         * IT IS ALSO WHAT KEEPS THIS ROUTE FROM BECOMING THE THING IT WAS PROTECTED FROM. The gate
         * is shared with `/auth/login` and takes turns between CALLERS and between the two ROUTES,
         * so a burst of registrations cannot put a member's sign-in behind it and a sign-in flood
         * cannot take this route's share of the CPU.
         *
         * A registrant can still be shed, but only by being the largest single contributor to the
         * backlog themselves — and being shed now costs them nothing but the request. That is the
         * 2026-08-12 reversal of the paragraph that stood here, which said the three rungs HAD been
         * charged by this point and called it deliberate ("making attempts free whenever the queue
         * is full would hand a caller a way to make unlimited ones"). The thing it was protecting
         * against does not exist: a shed request creates no account, so an unlimited number of them
         * is an unlimited number of nothing. What the charge really bought was measured — 83 honest
         * students shed by a sign-in flood, every one of them having spent a place in the students'
         * own budget on the way past.
         */
        const passwordHash = await hashUnderGate(req, res, 'sign-up', () =>
          hashPassword(body.password),
        );

        let account: UserRecord;
        try {
          /*
            A TRANSACTION FOR ONE INSERT AND ONE AUDIT ROW, WHICH IS NOT CEREMONY.

            It replaces `codes.redeem`, which used to own this transaction and whose whole job was
            to make the check and the write one indivisible step. That requirement did not go with
            the code: `findByEmail` a line above the INSERT is a check-then-act, and better-sqlite3
            runs this callback synchronously, so what makes it safe is that there is no `await`
            inside — the hash was paid before we got here for exactly this reason.

            The audit row is inside it as well, so an administrator can always answer "where did
            this account come from?" and the two facts can never disagree: no account without its
            row, no row without its account.
          */
          account = deps.db.transaction((): UserRecord => {
            if (users.findByEmail(body.email) !== undefined) throw new DuplicateEmailError();
            const created = users.create({
              email: body.email,
              passwordHash,
              // A LITERAL, not a parameter, not a default, not a variable. Registration produces
              // members; the only ways to become an administrator are the first-run token and an
              // existing administrator promoting you. This did not change when the door opened, and
              // it is the one sentence in this file that should never need editing again.
              role: 'member',
              ...(body.displayName === undefined ? {} : { displayName: body.displayName }),
            });
            appendAuditLog(deps.db, {
              userId: created.id,
              action: 'user.register',
              entityType: 'user',
              entityId: created.id,
              // A DISTINCT ACTION FROM `user.enroll` AND FROM `user.create`, because the three are
              // three different provenances and an operator reading the trail after this change
              // needs to tell them apart: `user.enroll` rows name the enrollment code an account
              // was created with and stop being written today, `user.create` is an administrator
              // making an account for somebody, and this is somebody making their own. The detail
              // is the coarse source network — the same /24 or /48 every other row on this route
              // carries, which is what an operator blocks or recognises — and never the address.
              detail: JSON.stringify({ origin: coarseOrigin(peerAddress(req)) }),
              atISO: nowISO,
            });
            return created;
          })();
        } catch (err) {
          if (err instanceof DuplicateEmailError) {
            // ONE WAY TO ARRIVE HERE, and it is rare: the address had no account when this request
            // started and had one by the time the transaction ran, fifty milliseconds later. The
            // loser of that race gets the generic sentence because we cannot tell them which of the
            // two of them they are, and the transaction rolled back, so nothing half-happened —
            // including the budget, which the `finally` releases unrecorded.
            throw new AppError('conflict', CONFLICT_GENERIC);
          }
          throw err;
        }

        /**
         * THE ACCOUNT EXISTS, SO NOW THE LADDER IS CHARGED — the one place in this handler that
         * writes to any of the three rungs, and the reason every sentence about them in this file
         * can be about accounts rather than about requests.
         *
         * AFTER the transaction has returned, deliberately: a `charge` inside it would survive a
         * rollback, because these counters are in memory and know nothing about SQLite.
         */
        for (const { attempt } of held) attempt.charge();
        announceClosedRungs(req, held, nowISO);

        startSession(req, res, account.id);
        // The same shape `/auth/bootstrap` and `/auth/me` answer with, from the same projection:
        // never the password hash, never the ICS token.
        res.status(201).json({ user: toPublicUser(account) });
      } finally {
        // SAFE TO CALL ON EVERY PATH INCLUDING THE CHARGED ONE — an attempt settles exactly once,
        // so this is a no-op after `charge` and a refund after anything else. It is a `finally` and
        // not a set of releases on each branch because a handler that throws somewhere unforeseen
        // must not leak three budget slots for the rest of the window.
        for (const { attempt } of held) attempt.release();
      }
    }),
  );

  router.post(
    '/auth/login',
    asyncHandler(async (req, res) => {
      const body = credentialsSchema.parse(req.body);
      /**
       * THE ACCOUNT AND THE TCP PEER, AND NOT `req.ip`.
       *
       * THE HALF THAT WAS ALREADY RIGHT. This key must not contain anything the client can rewrite.
       * `req.ip` follows `X-Forwarded-For` (`trust proxy` is set in `app.ts`), so a caller reaching
       * this process directly can mint a fresh bucket per request by rotating that header — which a
       * reviewer demonstrated once already, and which `test/api.auth.test.ts` pins.
       * `req.socket.remoteAddress` is the TCP peer: no header changes it and no client chooses it.
       *
       * THE HALF THAT WAS WRONG. Keyed on the address ALONE, the bucket was a weapon anybody could
       * point at anybody: the email is a value the CALLER supplies, so five wrong guesses at a name
       * a stranger picked refused that person's own correct password. MEASURED, 2026-08-05: 24
       * requests held one named officer out of their account for an hour, and no audit row was
       * written. Adding the peer means a stranger's failures accumulate against THEIR OWN
       * connection and the owner, signing in from anywhere else, never meets them.
       *
       * WHAT THIS DOES NOT FIX, said rather than implied. Behind a reverse proxy every client
       * shares one peer address, so on the documented deployment shape this composite collapses
       * back to the account and the lockout is still reachable by anybody who can get through the
       * tunnel. Closing that needs a client identity that is neither forgeable nor constant, and
       * this deployment has none: the only per-client value that survives a proxy is a header. The
       * alternative — keying on that header — trades a targeted lockout for unlimited password
       * guessing against every account at once, which is the worse of the two. Left here, in the
       * open, rather than papered over.
       */
      const key = `${peerAddress(req)}\x00${normalizeEmail(body.email)}`;

      /**
       * THE SAME SHAPE THE ENROLMENT ROUTE HAD, closed the same way and in the same change.
       *
       * `check` here and `recordFailure` after the `await` below meant that five was the number of
       * SEQUENTIAL wrong passwords one account tolerated, not the number of concurrent argon2id
       * verifies one account could be made to run — every request that arrived before the first
       * verify returned passed a counter none of them had paid into. `begin` claims the slot in the
       * same breath as it reads the budget, so five is now five either way.
       *
       * WHAT IT BOUNDS AND WHAT SOMETHING ELSE BOUNDS. This bucket bounds ATTEMPTS against one
       * account from one connection; it does not bound the work per SERVER, because a caller who
       * rotates the email address gets a fresh bucket each time and `verifyPasswordConstantTime`
       * runs a real argon2id verify against a dummy hash even when no such account exists — which
       * is deliberate, and is what stops the route leaking which addresses are accounts through
       * response timing. IT IS THEREFORE BLIND, BY CONSTRUCTION, TO THE CHEAPEST FLOOD THERE IS,
       * and that is not a defect in the key — a key that caught it would be a key an attacker
       * could point at a named person. What that blindness cost was measured on 2026-08-09 and is
       * answered in two other places rather than here: `MAX_QUEUED_HASHES`, so a caller sending a
       * fresh address every time gets one caller's share of the CPU instead of all of it, and
       * `FAILED_SIGN_IN_NOTICE`, so the operator finds out.
       *
       * This paragraph used to end by declining to bound the per-server work, on the grounds that
       * "a global gate on sign-in is a lockout for every user in the deployment at once", and was
       * then rewritten to say that a gate which QUEUES refuses nobody. Both were half right. A
       * shared queue with no ceiling and no notion of whose turn it is refuses nobody and starves
       * everybody: 512 connections here took a student's enrolment to 4,881 ms. What makes the
       * shared gate safe is not that it queues, it is that it takes turns.
       *
       * AND THERE IS STILL NO DEPLOYMENT-WIDE CEILING ON THIS ROUTE, WHICH IS A DECISION AND NOT AN
       * OVERSIGHT. A verifier put it as the headline of a finding on 2026-08-12: a flood here has
       * no ladder under it the way registration does, so it can lean on the shared gate until other
       * people's requests fall out of it. The half of that which is fixable has been fixed in the
       * two places it belongs — the gate takes turns between the routes, so a sign-in flood cannot
       * take sign-up's share of the CPU, and sign-up releases its budget when the gate sheds it, so
       * a flood here cannot spend a budget over there. A COUNTING ceiling on sign-ins is the half
       * that must not be built: behind the operator's tunnel every caller shares one peer, so a
       * deployment-wide sign-in budget is a switch that locks every member out of their own account
       * for fifteen minutes, and it is reachable by anybody who can send that many requests. That
       * is strictly worse than the flood it would answer. Registration can afford a ceiling because
       * being refused an account for fifteen minutes is an inconvenience to somebody who does not
       * have one yet; being refused sign-in is being locked out of the thing you already own.
       */
      const attempt = deps.loginLimiter.begin(key);
      if (!attempt.started) {
        /**
         * THE SENTENCE A LOCKED-OUT MEMBER READS, AND IT IS PRINTED VERBATIM BY THE SIGN-IN SCREEN
         * SINCE 2026-08-12, which is what made both halves of the old one worth fixing.
         *
         * "Too many sign-in attempts. Try again later." said WHEN, and `details.retryAfterSec`
         * beside it also says when — the second statement of one fact that this file has now
         * deleted from four refusals. The browser appends "Try again in 15 minutes.", so what
         * stood here would have rendered as "… Try again later. Try again in 15 minutes."
         *
         * AND IT SAID "ATTEMPTS" WITHOUT SAYING WHOSE. The key is the TCP peer and the address, and
         * `peerAddress` is one value for the whole deployment behind the owner's tunnel — so the
         * attempts that shut this bucket may be nothing to do with the person reading it, and no
         * network they can move to changes the key. That is the same defect the registration
         * ladder's middle rung had (see `rungWhere`), on the route where it matters more: this
         * reader HAS an account and is locked out of it. The paragraph above already says the
         * lockout is reachable by anybody who can get through the tunnel; this is that fact told to
         * the person it happens to, and `proxied` is measured the same way the ladder measures it.
         *
         * WHAT IT DOES NOT SAY is whether the address has an account, in either direction. The
         * bucket is charged for a wrong password against a real account and against no account at
         * all — `charge` runs on every failed verify — so the sentence has to be true of both
         * readers. That is why the reassurance is "nothing has been changed and no account has been
         * locked" rather than the warmer "the password on it still works", which would be a claim
         * about an account that may not exist, told to somebody who cannot tell.
         */
        const proxied = reportedOrigin(req) !== peerAddress(req);
        const whose = proxied
          ? 'Sign-ins for this email address have been refused too many times. This GrantSpotter ' +
            'is behind a proxy, so every sign-in arrives the same way and the failed attempts may ' +
            'not have been yours: signing in from another network or another device will not get ' +
            'past this.'
          : 'Too many failed sign-ins for this email address from this connection.';
        // Retry-After is a transport header; the body stays the one error envelope. See
        // `refuseWithRetryAfter` — this route answered 429 with no header at all until 2026-08-12.
        throw refuseWithRetryAfter(
          res,
          `${whose} Nothing has been changed and no account has been locked: what is refused is ` +
            'trying this address again, and it lifts on its own.',
          attempt.retryAfterSec,
        );
      }

      try {
        // Finding 2: never branch on "was a user found?" before verifying — that
        // reintroduces the account-existence timing leak
        // verifyPasswordConstantTime exists to close. user?.passwordHash is
        // passed straight through; whether the user exists, is disabled, or
        // typed the wrong password is decided only after the one argon2id
        // verify has already run.
        const user = users.findByEmail(body.email);
        const passwordOk = await hashUnderGate(req, res, 'sign-in', () =>
          verifyPasswordConstantTime(user?.passwordHash, body.password),
        );
        const credentialsOk = passwordOk && user !== undefined;

        if (!credentialsOk || user === undefined) {
          attempt.charge();
          /**
           * COUNTED HERE AND NOWHERE EARLIER, so the row means what it says. A request refused by
           * the schema, by the bucket above or by the gate is not a failed sign-in — it is a
           * request that never reached a password — and rolling those in would make the number an
           * operator sees stop being "somebody is trying passwords".
           *
           * The count is per coarsened TCP PEER and not per account: the traffic that produced no
           * audit rows at all was a caller who never used the same address twice, and the only
           * thing every one of those requests had in common was where it came from.
           */
          const coarsePeer = coarseOrigin(peerAddress(req));
          const failures = signInNotice.announce(coarsePeer);
          if (failures > 0) {
            appendAuditLog(deps.db, {
              userId: null,
              action: 'auth.failed_sign_ins',
              entityType: 'auth',
              entityId: coarsePeer,
              // Never an address, and never how many DISTINCT addresses were tried: the second
              // would be the more useful signal and it is also a list of who was asked about,
              // kept for longer and read by more people than the answers were.
              //
              // `failures` IS THE COUNT, NOT `FAILED_SIGN_IN_NOTICE`. It used to be the constant,
              // which meant a row saying `"failures":50` whether fifty arrived or fifty thousand
              // did — the same defect `auth.addresses_probed` carried and the same fix.
              // `ThresholdNotice.announce` re-announces at each doubling, so the magnitude reaches
              // the operator in a bounded number of rows.
              detail: JSON.stringify({
                failures,
                threshold: FAILED_SIGN_IN_NOTICE,
                windowSec: SIGN_IN_NOTICE_WINDOW_MS / 1000,
              }),
              atISO: new Date().toISOString(),
            });
          }
          throw new AppError('unauthorized', 'Incorrect email or password.');
        }

        /**
         * THE ACCOUNT IS REAL, THE PASSWORD IS RIGHT, AND AN ADMINISTRATOR HAS SWITCHED IT OFF.
         *
         * IT WAS FOLDED INTO "Incorrect email or password." UNTIL 2026-08-12, in one expression:
         * `const ok = passwordOk && user !== undefined && !user.disabled`. MEASURED against the
         * built server on this host — enrol, sign in 200, `UPDATE users SET disabled=1`, then the
         * SAME correct password — 401 "Incorrect email or password.", byte for byte what a wrong
         * password answers. The sentence is false and it is false in the direction that costs the
         * reader the most: it sends the one person who cannot fix anything off to reset a password
         * that was never wrong, and on this product that means asking an administrator for a reset
         * (there is no reset mail) — the same administrator who just switched the account off.
         *
         * THE ANTI-ENUMERATION ARGUMENT DOES NOT REACH THIS STATE, and that is why this is not the
         * timing leak the comment above guards. Everything above this line is decided AFTER one
         * argon2id verify precisely so that a stranger cannot tell an account from a non-account.
         * This branch is past that: reaching it requires the correct password for a real account,
         * which is proof of ownership, not a probe. A reader who is here knows the account exists —
         * they own it. Nothing is disclosed to anybody who did not already have it.
         *
         * IT DOES NOT CHARGE THE FAILURE BUDGET AND IT DOES NOT COUNT TOWARDS `FAILED_SIGN_IN_NOTICE`.
         * Neither is a judgement call about kindness. The budget's subject is "how many GUESSES an
         * anonymous caller may make at a credential" and this is not a guess; charging it would put
         * the bucket's refusal — "Sign-ins for this email address have been refused too many
         * times … nothing has been changed and no account has been locked" — in front of the fifth
         * try, which is a second false sentence stacked on the first, and false in the one word
         * that matters here, because an administrator HAS switched this account off. The notice's subject is "somebody is trying
         * passwords", and one person typing their own correct password is not that. A caller cannot
         * use this as a free-hash path they did not already have: `hashGate` bounds the work, and
         * the docblock above already records that a caller rotating the email address gets an
         * unbudgeted verify by construction.
         *
         * 401 AND NOT 403, which is the arguable one. 403 reads better in the abstract — the
         * credentials were accepted and the action is refused — but `routes/Login.tsx` maps an
         * unrecognised code to "the server answered 403. It could not be reached for a verdict on
         * these credentials", which is itself untrue: a verdict was reached. 401 keeps the status
         * this route has always answered for "you are not signed in", and the sentence carries the
         * difference.
         */
        if (user.disabled) {
          throw new AppError('unauthorized', ACCOUNT_DISABLED);
        }

        // Reset stays HERE and does not on the enrolment route, and the difference is what the
        // bucket names: this one is one account reached from one connection, and the person who has
        // just proved they own that account is clearing their own failed attempts. The enrolment
        // guess bucket is not owned by anybody, so nothing anybody does there can clear it.
        deps.loginLimiter.reset(key);
        const at = new Date().toISOString();
        users.recordLogin(user.id, at);
        // Deliberately does NOT call sessions.removeAllForUser here: multiple
        // concurrent sessions per user (e.g. a laptop and a phone) are
        // intended. Revocation-on-login was reverted per fix round 1 — see
        // the Task 17 report.
        startSession(req, res, user.id);
        res.json({ user: toPublicUser({ ...user, lastLoginAt: at }) });
      } finally {
        attempt.release();
      }
    }),
  );

  router.post('/auth/logout', (req, res) => {
    // Finding 1: a session row's existence is not validity — but logout only
    // ever needs to delete the row the *current, already-authenticated*
    // request resolved. req.sessionKey is set by auth/middleware.ts's
    // attachUser, which re-checks expiresAt itself before setting it (see
    // Task 17 report), so there is nothing further to validate here.
    if (req.sessionKey !== undefined) sessions.remove(req.sessionKey);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.status(204).end();
  });

  router.get('/auth/me', requireAuth(), (req, res) => {
    const user = req.auth === undefined ? undefined : users.findById(req.auth.id);
    if (user === undefined) throw new AppError('unauthorized', 'Sign in to continue.');
    res.json({ user: toPublicUser(user) });
  });

  return router;
}
