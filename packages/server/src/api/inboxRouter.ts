import { Router } from 'express';
import type { ChangeKind, Program, ReviewDecision, ReviewItem } from '@grantspotter/core';
import { parseRecurrence, programSchema } from '@grantspotter/core';
import { getReviewItem } from '../db/repositories/ingestion.js';
// RESOLUTIONS R26: Plan 2 Task 21 owns the review pipeline. This router is the
// only human-facing caller of it, so it delegates rather than re-implementing.
import {
  SuppressedProgramError,
  approveReviewItem,
  editReviewItem,
  rejectReviewItem,
  rejectKeyFor,
} from '../review/index.js';
import type { RouterDeps } from './deps.js';
import { AppError } from './errors.js';
import { reindexBrowse } from './reindex.js';
import { drainChangeEvents } from './notify.js';

/** PLAN-LOCAL to Plan 3. */
export interface InboxRow {
  id: string;
  decision: ReviewDecision;
  decidedBy: string | null;
  decidedAt: string | null;
  confidence: number;
  rejectKey: string | null;
  candidate: Program;
  changeEvent: {
    id: string;
    sourceId: string;
    programId: string | null;
    kind: ChangeKind;
    before: string | null;
    after: string | null;
    detectedAt: string;
    fieldPath: string | null;
  } | null;
}

const DECISIONS: ReviewDecision[] = ['pending', 'approved', 'rejected', 'edited'];

/**
 * THE RECURRENCE RULE A `DeadlineSpec.note` ENCODES, as a value two notes can be compared by.
 *
 * `parseRecurrence` is the one parser and this adds none: it runs core's, and stringifies what
 * comes back. `{"kind":"none"}` for a note with no directive, the whole rule for a note with one,
 * and `unreadable` for a directive core throws on — which is deliberately its own value and not
 * `none`, so that a directive nobody can read still cannot be dropped by an edit.
 *
 * Comparing the PARSED rule rather than the directive's bytes is the difference between a guard
 * on the schedule and a guard on the whitespace. `RECUR n_fixed_dates tz=UTC dates=02-01` and the
 * same directive with two spaces are the same set of future dates, and refusing the second would
 * be this route inventing a rule about formatting.
 */
function recurrenceOf(note: string): string {
  try {
    return JSON.stringify(parseRecurrence(note.trim()));
  } catch {
    return 'unreadable';
  }
}

function text(json: string | null): string | null {
  if (json === null) return null;
  const value: unknown = JSON.parse(json);
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * The queue is the whole review backlog, not a page of it: the biggest real
 * source (`arrl-scholarship-descriptions`) puts 111 rows in on its first crawl
 * and the Inbox UI (Task 23) filters client-side. The cap exists so a runaway
 * source cannot turn one GET into a megabyte of JSON; it is deliberately far
 * above any real night's queue rather than a page size the UI has to page
 * through.
 */
const MAX_ROWS = 500;

export function createInboxRouter(deps: RouterDeps): Router {
  const router = Router();

  // Readable by every authenticated user. Members see it read-only on purpose:
  // knowing a deadline change is PENDING REVIEW is itself trust information.
  router.get('/', deps.requireAuth, (req, res) => {
    const user = deps.currentUser(req);
    const wanted = DECISIONS.includes(String(req.query.decision) as ReviewDecision)
      ? String(req.query.decision)
      : null;

    const rows = deps.db
      .prepare(
        `SELECT ri.id AS id, ri.decision AS decision, ri.decided_by AS decided_by,
                ri.decided_at AS decided_at, ri.confidence AS confidence,
                ri.reject_key AS reject_key, ri.candidate_json AS candidate_json,
                ce.id AS ce_id, ce.source_id AS ce_source_id, ce.program_id AS ce_program_id,
                ce.kind AS ce_kind, ce.before_json AS ce_before, ce.after_json AS ce_after,
                ce.detected_at AS ce_detected_at, ce.field_path AS ce_field_path
           FROM review_items ri
           LEFT JOIN change_events ce ON ce.id = ri.change_event_id
          ${wanted ? 'WHERE ri.decision = ?' : ''}
          ORDER BY COALESCE(ce.detected_at, '') DESC, ri.id DESC
          LIMIT ${MAX_ROWS}`,
      )
      .all(...(wanted ? [wanted] : [])) as Array<Record<string, string | number | null>>;

    const mapped: InboxRow[] = rows.map((r) => ({
      id: String(r.id),
      decision: String(r.decision) as ReviewDecision,
      decidedBy: r.decided_by === null ? null : String(r.decided_by),
      decidedAt: r.decided_at === null ? null : String(r.decided_at),
      confidence: Number(r.confidence),
      rejectKey: r.reject_key === null ? null : String(r.reject_key),
      candidate: JSON.parse(String(r.candidate_json)) as Program,
      changeEvent: r.ce_id === null || r.ce_id === undefined
        ? null
        : {
            id: String(r.ce_id),
            sourceId: String(r.ce_source_id),
            programId: r.ce_program_id === null ? null : String(r.ce_program_id),
            kind: String(r.ce_kind) as ChangeKind,
            before: text(r.ce_before === null ? null : String(r.ce_before)),
            after: text(r.ce_after === null ? null : String(r.ce_after)),
            detectedAt: String(r.ce_detected_at),
            fieldPath: r.ce_field_path === null ? null : String(r.ce_field_path),
          },
    }));

    res.json({ rows: mapped, canDecide: user.role === 'admin' });
  });

  /**
   * BRIEF DEVIATION, and the defect it closes. The brief had this route accept a
   * `rejectKey` FROM THE CLIENT and write it over the row before delegating —
   * Task 23's UI posts `"<sourceId>:<fieldPath>:<after>"`. `rememberReject` then
   * stores that human-readable string, but `buildReviewItems` looks reject
   * memory up under `rejectKeyFor(sourceId, candidate)`, a sha256 over
   * `sourceId|program.id|hashProgram(program)`. A key a browser composed is one
   * the crawler will never compute, so the rejection would suppress nothing and
   * the candidate would return every night under a fresh review-item id — the
   * exact bug RESOLUTIONS R26 says delegating to Plan 2 exists to avoid, put
   * back one line above the delegation.
   *
   * So the key is derived here, never accepted: Plan 2's own `rejectKeyFor`,
   * over the stored candidate and the change event's source, and only for a row
   * that has none (every row `buildReviewItems` writes already carries one).
   * A client-supplied `rejectKey` is ignored; the reviewer's words belong in
   * `reason`, which is what the audit trail records.
   */
  function rejectKeyOf(item: ReviewItem): string | undefined {
    if (item.rejectKey !== undefined) return item.rejectKey;
    const row = deps.db
      .prepare('SELECT source_id FROM change_events WHERE id = ?')
      .get(item.changeEventId) as { source_id: string } | undefined;
    if (row === undefined) return undefined;
    return rejectKeyFor(row.source_id, item.candidate);
  }

  /**
   * RESOLUTIONS R26. Everything that touches the corpus, the reject memory or
   * the audit trail happens inside Plan 2's `approveReviewItem` /
   * `rejectReviewItem` / `editReviewItem`. What lives here is the HTTP shell:
   * validation, Plan 1's error envelope, and the two Plan-3-owned derived-state
   * rebuilds the review pipeline knows nothing about.
   */
  router.post('/:id/decision', deps.requireAuth, deps.requireAdmin, (req, res, next) => {
    const user = deps.currentUser(req);
    const nowISO = deps.now();
    const body = req.body as { decision?: unknown; candidate?: unknown; reason?: unknown };

    const decision = String(body.decision) as ReviewDecision;
    if (!DECISIONS.includes(decision) || decision === 'pending') {
      next(new AppError(
        'validation_failed',
        `"${String(body.decision)}" is not a decision. Expected approved, rejected or edited.`,
      ));
      return;
    }

    // Checked here so an unknown id is a 404 in Plan 1's envelope rather than
    // the bare `Error("unknown review item …")` the review pipeline throws.
    const item = getReviewItem(deps.db, req.params.id);
    if (item === undefined) {
      next(new AppError('not_found', `No review item with id "${req.params.id}".`));
      return;
    }

    let edited: Program | undefined;
    if (decision === 'edited') {
      const parsed = programSchema.safeParse(body.candidate);
      if (!parsed.success) {
        next(new AppError(
          'validation_failed',
          'The edited candidate is not a valid Program.',
          parsed.error.issues,
        ));
        return;
      }
      edited = parsed.data as Program;

      /**
       * THE ONE THING AN EDIT MAY NOT DO, CHECKED WHERE IT CANNOT BE SKIPPED.
       *
       * `deadline.note` carries the `RECUR` directive `expandCycles` reads, and `editReviewItem`
       * re-projects the record's cycles from the edited note — `writeCyclesFor` deletes the old
       * ones first. So an edit that drops the directive does not merely stop adding dates: it
       * DELETES every future date already published for that programme, and for every record
       * that inherits its deadline. Measured on the shipped corpus by removing the directive from
       * one queued candidate through the Inbox: the ARRL Foundation record went from 2 projected
       * cycles to 0, its 112 inheritors from 224 to 0, and the whole `cycles` table from 243 rows
       * to 17 — in one press of "Save and approve", reported to the reviewer as "Edited by hand
       * and written to the corpus."
       *
       * Task 23's panel no longer puts the directive in the textarea at all, which is the fix a
       * human meets. This is the one that holds when the request does not come from that panel:
       * the route accepts a whole Program from any administrator's HTTP client, and a corpus
       * invariant enforced only in a browser is not enforced.
       *
       * It is DIRECTIONAL — a stored rule must survive, a stored note with no rule may gain one.
       * The failure being closed is silent deletion of a rule the reviewer was never shown; a
       * note that carries none has nothing to lose, and refusing that case would forbid the
       * normalizer's own re-encoding of a note during review for no stated reason.
       */
      const storedRule = recurrenceOf(item.candidate.deadline.note);
      if (storedRule !== '{"kind":"none"}' && recurrenceOf(edited.deadline.note) !== storedRule) {
        next(new AppError(
          'validation_failed',
          'The deadline note on this candidate carries the repeat rule GrantSpotter reads to ' +
            'generate every future date for this programme, and this edit does not carry the ' +
            'same rule. Saving it would delete those dates, here and on every record that ' +
            'inherits this deadline. The review queue edits the funder’s own sentences and ' +
            'leaves the rule alone; a rule that is itself wrong is a fix to the source this ' +
            'record came from, not to one queued candidate.',
        ));
        return;
      }
    }

    // `published` means "the corpus was written". For an approved `vanished`
    // event that write is a deletion, and the browse projection — which is
    // rebuilt wholesale — has to lose the row either way.
    const published = decision !== 'rejected';

    // One transaction for the decision AND the two derived-state rebuilds. A
    // failure between them would otherwise leave a published program behind a
    // review item still reading `pending`, or a corpus the browse projection no
    // longer describes — states no later crawl repairs, because the crawl only
    // ever looks at what CHANGED.
    const decide = deps.db.transaction(() => {
      // FAN OUT FIRST — the ordering defect Task 8 found. `watches.program_id`
      // is `ON DELETE CASCADE` and approving a `vanished` event DELETES the
      // program, so deciding first cascades away the very rows that say who to
      // tell. `drainChangeEvents` would then find no watchers and write a
      // `change_event_fanout` row recording the event as delivered, which is
      // permanent: the drain is idempotent by that ledger and never retries. The
      // one person guaranteed never to hear "this programme disappeared from its
      // funder's site" would be the user who asked to be told about it.
      //
      // The drain is a global, idempotent "deliver whatever is undelivered"
      // pass, not this route's private notifier — `notificationRouter` calls it
      // on every read and `verifyRouter` after every refetch. So it is safe in
      // either position, and only one of the two positions can deliver a
      // deletion.
      if (published) drainChangeEvents(deps.db, nowISO);

      if (decision === 'approved') {
        // Publishes, or DELETES when the change event kind is `vanished`, and
        // carries sourceKeyFor(candidate) into programs.source_id /
        // external_key so tomorrow's crawl resolves the record instead of
        // minting a duplicate (R9).
        approveReviewItem(deps.db, item.id, user.id, nowISO);
      } else if (decision === 'edited') {
        editReviewItem(deps.db, item.id, user.id, nowISO, edited as Program);
      } else {
        const key = rejectKeyOf(item);
        if (key !== undefined && item.rejectKey === undefined) {
          deps.db.prepare('UPDATE review_items SET reject_key = ? WHERE id = ?').run(key, item.id);
        }
        rejectReviewItem(
          deps.db, item.id, user.id, nowISO,
          typeof body.reason === 'string' && body.reason.trim() !== ''
            ? body.reason
            : 'rejected in the review Inbox',
        );
      }

      // The browse projection is rebuilt from the corpus, so it can only run
      // after the corpus write.
      if (published) reindexBrowse(deps.db, nowISO);
    });

    try {
      decide();
    } catch (err: unknown) {
      // The `do_not_publish` backstop is a deliberate refusal, not a crash: it
      // fires on a review-item row persisted before `buildReviewItems` started
      // gating, and it is the last thing standing between 37 already-funded
      // clubs and a browse list that presents them as open opportunities. It has
      // to arrive as a conflict a reviewer can read, not as a 500 that reads
      // like the server broke and invites a retry.
      next(err instanceof SuppressedProgramError ? new AppError('conflict', err.message) : err);
      return;
    }

    res.json({ id: item.id, decision, decidedBy: user.id, decidedAt: nowISO, published });
  });

  return router;
}
