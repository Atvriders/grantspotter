import { randomUUID } from 'node:crypto';
import { AppError } from '../../api/errors.js';
import {
  type ExportReadiness,
  type FactChecklistItem,
  type FactConfirmation,
  type FactSource,
  buildFactChecklist,
  exportReadiness,
  extractFactAssertions,
  factSourcesFromKnowledge,
} from '../../prose/facts.js';
import { renderSlotValue } from '../../templates/fill.js';
import { type SlotContextInput, describeSlotKnowledge } from '../../templates/slots.js';
import type { Db } from '../migrate.js';
import { createFunderRepo } from './funders.js';
import { createProfileRepo } from './profiles.js';
import { createProgramRepo } from './programs.js';

export interface ApplicationRow {
  id: string;
  userId: string;
  programId?: string;
  title: string;
  bodyMarkdown: string;
  answers: Record<string, string>;
  factConfirmations: Record<string, FactConfirmation>;
  includeDisclosure: boolean;
  factsConfirmedAt?: string;
  createdAt: string;
  updatedAt: string;
}

interface RawRow {
  id: string;
  user_id: string;
  program_id: string | null;
  title: string;
  body_markdown: string;
  answers_json: string;
  fact_confirmations_json: string;
  include_disclosure: number;
  facts_confirmed_at: string | null;
  created_at: string;
  updated_at: string;
}

const OWNER = 'packages/server/src/db/migrations/001-init.sql';

/**
 * RESOLUTIONS R24: Plan 1's 001-init.sql owns both tables. This map is asserted,
 * never created. Modelled on Plan 2's `ensureIngestionSchema`, for the same
 * reason: `CREATE TABLE IF NOT EXISTS` matches on the table NAME, so a second
 * declaration in a later migration is a silent no-op and the columns it lists
 * never come into existence.
 */
const REQUIRED_COLUMNS: Record<string, string[]> = {
  applications: [
    'id',
    'user_id',
    'program_id',
    'title',
    'body_markdown',
    'answers_json',
    'fact_confirmations_json',
    'include_disclosure',
    'facts_confirmed_at',
    'created_at',
    'updated_at',
  ],
  template_instances: [
    'id',
    'application_id',
    'template_id',
    'position',
    'filled_markdown',
    'unresolved_slots_json',
    'created_at',
  ],
};

/**
 * Assert-never-create. Called once when the applications router is constructed,
 * so a schema drift is a startup error with a filename in it rather than a
 * `SQLITE_ERROR: table applications has no column named answers_json` on the
 * first PATCH a user makes.
 */
export function assertApplicationSchema(db: Db): void {
  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.length === 0) {
      throw new Error(
        `Missing table "${table}". ${OWNER} owns it — run migrate(db) before ` +
          'constructing the applications router. This module never creates it.',
      );
    }
    const have = new Set(columns.map((c) => c.name));
    const missing = required.filter((c) => !have.has(c));
    if (missing.length > 0) {
      throw new Error(
        `Table "${table}" is missing columns [${missing.join(', ')}]. ${OWNER} owns this shape ` +
          '(RESOLUTIONS R24). Fix it there. Do NOT add a second CREATE TABLE in another ' +
          'migration — SQLite matches CREATE TABLE IF NOT EXISTS on the name, so the second ' +
          "definition silently never runs — and do NOT delete Plan 1's CREATE TABLE, because " +
          'its CREATE INDEX statements would then reference a table that does not exist and ' +
          'migration 001 would abort.',
      );
    }
  }
}

function hydrate(row: RawRow): ApplicationRow {
  const out: ApplicationRow = {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    bodyMarkdown: row.body_markdown,
    answers: JSON.parse(row.answers_json) as Record<string, string>,
    factConfirmations: JSON.parse(row.fact_confirmations_json) as Record<string, FactConfirmation>,
    includeDisclosure: row.include_disclosure === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.program_id !== null) out.programId = row.program_id;
  if (row.facts_confirmed_at !== null) out.factsConfirmedAt = row.facts_confirmed_at;
  return out;
}

/**
 * `now` is a required parameter on every writing function rather than a call to
 * `new Date()`. Plan 3's `RouterDeps` injects the clock precisely so a test can
 * pin a timestamp, and a repository that quietly reads the wall clock makes that
 * injection decorative: `deps.now` would be passed in, ignored, and nobody would
 * notice until a timestamp assertion could not be written.
 */
export type Clock = () => string;

export function createApplication(
  db: Db,
  input: { userId: string; title: string; programId?: string },
  now: Clock,
): ApplicationRow {
  const at = now();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO applications (id, user_id, program_id, title, body_markdown, answers_json,
       fact_confirmations_json, include_disclosure, facts_confirmed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', '{}', '{}', 1, NULL, ?, ?)`,
  ).run(id, input.userId, input.programId ?? null, input.title, at, at);
  return getApplication(db, id, input.userId) as ApplicationRow;
}

/**
 * `updated_at DESC` is what `idx_applications_user (user_id, updated_at DESC)`
 * serves. The `id` tiebreaker is not decoration: with an injected clock — and on
 * any machine fast enough to write two rows inside one millisecond — several
 * drafts share an `updated_at`, and SQLite is free to return those in any order.
 * A draft list that reshuffles between two identical requests is a bug the user
 * sees long before a test does.
 */
export function listApplications(db: Db, userId: string): ApplicationRow[] {
  const rows = db
    .prepare('SELECT * FROM applications WHERE user_id = ? ORDER BY updated_at DESC, id')
    .all(userId) as RawRow[];
  return rows.map(hydrate);
}

export function getApplication(db: Db, id: string, userId: string): ApplicationRow | undefined {
  const row = db.prepare('SELECT * FROM applications WHERE id = ? AND user_id = ?').get(id, userId) as
    | RawRow
    | undefined;
  return row ? hydrate(row) : undefined;
}

export interface ApplicationPatch {
  title?: string;
  bodyMarkdown?: string;
  answers?: Record<string, string>;
  includeDisclosure?: boolean;
  /**
   * `null` detaches the draft from its opportunity; `undefined` leaves it alone.
   * The two are NOT interchangeable, which is why this is read with an explicit
   * `=== undefined` test rather than `??`.
   */
  programId?: string | null;
}

export function updateApplication(
  db: Db,
  id: string,
  userId: string,
  patch: ApplicationPatch,
  now: Clock,
): ApplicationRow | undefined {
  const existing = getApplication(db, id, userId);
  if (!existing) return undefined;
  const next = {
    title: patch.title ?? existing.title,
    bodyMarkdown: patch.bodyMarkdown ?? existing.bodyMarkdown,
    answers: patch.answers ? { ...existing.answers, ...patch.answers } : existing.answers,
    includeDisclosure: patch.includeDisclosure ?? existing.includeDisclosure,
    programId: patch.programId === undefined ? (existing.programId ?? null) : patch.programId,
  };
  db.prepare(
    `UPDATE applications
     SET title = ?, body_markdown = ?, answers_json = ?, include_disclosure = ?,
         program_id = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`,
  ).run(
    next.title,
    next.bodyMarkdown,
    JSON.stringify(next.answers),
    next.includeDisclosure ? 1 : 0,
    next.programId,
    now(),
    id,
    userId,
  );
  return getApplication(db, id, userId);
}

/**
 * WHAT A STORED CONFIRMATION HAS TO CARRY, and why this function exists.
 *
 * A `FactAssertion.id` is `${kind}:${start}` — a POSITION. Editing `$1,450` to `$9,999` leaves the
 * id identical, so a confirmation stored under it lands on a number no human ever read. Task 14
 * fixed that by fingerprinting the value: a stored confirmation naming a different fingerprint does
 * not apply. But the fingerprint only protects a confirmation that HAS one, and the field is
 * optional on `FactConfirmation` for backward compatibility, so a client that sends
 * `{confirmed, note}` and nothing else would reintroduce the defect in full — silently, with every
 * existing test still green.
 *
 * So this normalizes, and never trusts absence:
 *   - a fingerprint the caller sent is stored VERBATIM, including one that disagrees with the text
 *     as it stands now. That disagreement is real information: the caller confirmed something else,
 *     and the item must read `staleConfirmation`.
 *   - a fingerprint the caller omitted is DERIVED from the fact currently at that id. That records
 *     what the document said at the moment of the confirmation, which is the only defensible
 *     reading of "the user confirmed this", and it means no confirmation can ever survive an edit
 *     to the value it confirms — regardless of how old the client is.
 *   - an id that is not a fact in the draft at all is reported in `unknownFactIds`. Storing it
 *     fingerprint-less would leave a confirmation waiting at that position for whatever text lands
 *     there later, which is the same defect through a third door.
 */
export interface ConfirmationResolution {
  resolved: Record<string, FactConfirmation>;
  unknownFactIds: string[];
}

export function resolveConfirmations(
  bodyMarkdown: string,
  incoming: Record<string, FactConfirmation>,
): ConfirmationResolution {
  const fingerprints = new Map(extractFactAssertions(bodyMarkdown).map((f) => [f.id, f.fingerprint]));
  const resolved: Record<string, FactConfirmation> = {};
  const unknownFactIds: string[] = [];

  for (const [id, confirmation] of Object.entries(incoming)) {
    const current = fingerprints.get(id);
    if (current === undefined) {
      unknownFactIds.push(id);
      continue;
    }
    resolved[id] = {
      confirmed: confirmation.confirmed,
      note: confirmation.note,
      fingerprint: confirmation.fingerprint ?? current,
    };
  }

  return { resolved, unknownFactIds };
}

export function setFactConfirmations(
  db: Db,
  id: string,
  userId: string,
  confirmations: Record<string, FactConfirmation>,
  now: Clock,
): ApplicationRow | undefined {
  const existing = getApplication(db, id, userId);
  if (!existing) return undefined;
  // A superseded confirmation is kept rather than pruned: `buildFactChecklist` reads it only when
  // a fact reappears at the same id, and then the fingerprint decides. The note the applicant wrote
  // is evidence about the item and outlives the value it was written against.
  const merged = { ...existing.factConfirmations, ...confirmations };
  const at = now();
  const readiness = applicationReadiness(db, { ...existing, factConfirmations: merged });
  db.prepare(
    'UPDATE applications SET fact_confirmations_json = ?, facts_confirmed_at = ?, updated_at = ? WHERE id = ? AND user_id = ?',
  ).run(JSON.stringify(merged), readiness.ready ? at : null, at, id, userId);
  return getApplication(db, id, userId);
}

export function deleteApplication(db: Db, id: string, userId: string): boolean {
  // `template_instances.application_id` is ON DELETE CASCADE, so this statement is belt to that
  // brace: it keeps the delete correct in any handle that was opened without `foreign_keys = ON`.
  db.prepare(
    'DELETE FROM template_instances WHERE application_id IN (SELECT id FROM applications WHERE id = ? AND user_id = ?)',
  ).run(id, userId);
  const info = db.prepare('DELETE FROM applications WHERE id = ? AND user_id = ?').run(id, userId);
  return info.changes > 0;
}

/**
 * Who stated each value this draft could be quoting, for the checklist's `origin`.
 *
 * WITHOUT THIS, EVERY ITEM READS `unattributed`. `buildFactChecklist(text, confirmations)` takes a
 * third `sources` argument and defaults it to `[]`, so a caller that forgets it gets a full,
 * plausible-looking checklist in which the funder's own published figure and a sentence a model
 * invented are indistinguishable — a wall of identical checkboxes instead of a reviewable list.
 *
 * BOTH profiles, not one. A user may hold a student profile and an organization profile at once
 * (`profiles` is UNIQUE per user AND kind), and `describeSlotKnowledge` takes a single applicant:
 * asked about the organization it rules every `student.*` slot `not_applicable` and vice versa. So
 * it is asked once per profile and the answers are unioned. Both halves are values this user
 * really stated, so attribution can only become more complete, never wrong — and where two sources
 * disagree about who said something, `attribute()` already refuses to guess and returns
 * `unattributed`.
 */
export function applicationFactSources(db: Db, app: ApplicationRow): FactSource[] {
  const profiles = createProfileRepo(db).listForUser(app.userId);
  const program = app.programId === undefined ? undefined : createProgramRepo(db).get(app.programId);
  const funder = program === undefined ? undefined : createFunderRepo(db).get(program.funderId);

  const base: SlotContextInput = { program, funder, answers: app.answers };
  const inputs: SlotContextInput[] =
    profiles.length > 0 ? profiles.map((profile) => ({ ...base, profile })) : [base];

  const merged = new Map<string, FactSource>();
  for (const input of inputs) {
    for (const source of factSourcesFromKnowledge(describeSlotKnowledge(input), renderSlotValue)) {
      // THE SEPARATOR IS WRITTEN AS AN ESCAPE, never as a raw NUL byte in the source. A literal
      // NUL is a perfectly good map-key separator at runtime and it compiles, but it makes this
      // WHOLE FILE binary to grep: `grep -q "export function assertExportReady" …` — Task 20's
      // own verification gate — reported NO MATCH against a file that plainly contains it, and
      // so would any audit sweep of this file for a leaked host, a key or a phantom claim. A
      // silence that reads as a clean result is the failure this repository exists to hunt.
      // The escape is the identical string.
      merged.set(`${source.slot}\u0000${source.origin}\u0000${source.value}`, source);
    }
  }
  return [...merged.values()].sort(
    (a, b) => a.slot.localeCompare(b.slot) || a.origin.localeCompare(b.origin),
  );
}

export function applicationChecklist(db: Db, app: ApplicationRow): FactChecklistItem[] {
  return buildFactChecklist(app.bodyMarkdown, app.factConfirmations, applicationFactSources(db, app));
}

export function applicationReadiness(db: Db, app: ApplicationRow): ExportReadiness {
  return exportReadiness(app.bodyMarkdown, app.factConfirmations, applicationFactSources(db, app));
}

/**
 * THE SPEC §10.4 EXPORT GATE. Called by Plan 5's export endpoints — DOCX,
 * Markdown, ZIP and PDF alike — before a single byte of the draft is rendered.
 *
 * Every funder policy reviewed makes the human, not the tool, accountable for
 * the content, so this throws while ANY of these is true:
 *   1. any extracted factual assertion has never been confirmed
 *      (readiness.unconfirmed > 0, once the stale ones below are set aside), or
 *   2. any `[TODO: …]` marker remains in the draft body
 *      (exportReadiness().openTodos > 0), or
 *   3. any raw, unfilled `{{slot.path}}` template placeholder remains in the
 *      draft body (exportReadiness().rawSlots > 0) — the shape left behind
 *      when template markdown reaches the editor without going through
 *      `fillTemplate`, so no `[TODO: …]` marker was ever written for it, or
 *   4. a fact WAS confirmed and then its text changed underneath the tick —
 *      `readiness.items[].staleConfirmation` — so the earlier confirmation no
 *      longer applies to what the draft now says.
 *
 * THE MESSAGE NAMES ONLY WHAT IS ACTUALLY TRUE. Each of the four gets its own
 * clause, with its own count, and a clause is omitted entirely when its count
 * is zero — a message that always recited "N unconfirmed and M open TODOs"
 * regardless of which gate actually fired sent a raw-`{{slot}}` refusal or a
 * stale-only refusal to a user who then went looking for unconfirmed facts
 * that did not exist. A WRONG EXPLANATION IS WORSE THAN A BARE FAILURE.
 *
 * Case 4 gets its own wording rather than folding into case 1's count.
 * `readiness.unconfirmed` counts a stale item as unconfirmed too — correct for
 * the boolean gate — but the applicant DID confirm it, then edited the value;
 * calling that "unconfirmed" reads as though the earlier work was thrown away.
 * Case 1 below is therefore `readiness.unconfirmed` with the stale ones
 * subtracted out, so the two clauses partition the same underlying count
 * rather than double-naming the same items two different ways.
 *
 * It throws AppError('conflict', …) — HTTP **409** through Plan 1's
 * errorHandler — for an ungated draft, and AppError('not_found', …) — HTTP 404
 * — when the id does not belong to userId, so an export can never read across
 * users. It returns void and mutates nothing.
 *
 * It goes through `applicationReadiness` — the SAME call the router answers
 * `GET /:id/export-readiness` with, sources and all — rather than the cheaper
 * source-less `exportReadiness(body, confirmations)`. Attribution does not
 * currently change the verdict, but "currently" is the word that makes a gate
 * and the screen above it drift apart, and the failure would be a user shown
 * "ready to export" receiving a 409, or worse, the reverse.
 *
 * An export path that does not call this is a spec §10.4 violation: a direct
 * POST would then emit a draft carrying unverified figures and literal
 * "[TODO: …]" text into a funder's inbox.
 */
export function assertExportReady(db: Db, applicationId: string, userId: string): void {
  const app = getApplication(db, applicationId, userId);
  if (!app) throw new AppError('not_found', 'No draft with that id belongs to you.');
  const readiness = applicationReadiness(db, app);
  if (!readiness.ready) {
    const staleConfirmations = readiness.items.filter((item) => item.staleConfirmation).length;
    // `unconfirmed` already counts a stale item (buildFactChecklist forces `confirmed: false` on
    // one), so subtracting gives the count of facts nobody has EVER confirmed — the two clauses
    // below partition `unconfirmed`, they do not add a fifth number.
    const neverConfirmed = readiness.unconfirmed - staleConfirmations;

    const clauses: string[] = [];
    if (neverConfirmed > 0) {
      clauses.push(`${neverConfirmed} unconfirmed factual assertion(s)`);
    }
    if (readiness.openTodos > 0) {
      clauses.push(`${readiness.openTodos} unresolved [TODO: …] marker(s)`);
    }
    if (readiness.rawSlots > 0) {
      // A raw `{{slot.path}}` has no vocabulary hint the way a `[TODO: …]` marker does, so the
      // message has to say which slot belongs there and where to go fix it — the template — or
      // the applicant is left staring at a brace pair with no clue what it means.
      const slots = readiness.rawSlotPaths.map((path) => `{{${path}}}`).join(', ');
      clauses.push(
        `${readiness.rawSlots} raw template placeholder(s) that were never filled in (${slots}) — ` +
          `go back to the template for this slot and fill it in, or replace the placeholder with real text`,
      );
    }
    if (staleConfirmations > 0) {
      // Never call this "unconfirmed": the applicant DID confirm it. Say what actually happened —
      // the value under the tick changed, so the earlier confirmation no longer covers it.
      clauses.push(
        `${staleConfirmations} confirmation(s) that no longer apply, because the value changed ` +
          `after you confirmed it — re-read the new text and confirm it again`,
      );
    }

    const message = `This draft is not ready to export: ${clauses.join('; ')}.`;
    throw new AppError('conflict', message, {
      unconfirmed: readiness.unconfirmed,
      neverConfirmed,
      staleConfirmations,
      openTodos: readiness.openTodos,
      rawSlots: readiness.rawSlots,
      rawSlotPaths: readiness.rawSlotPaths,
    });
  }
}
