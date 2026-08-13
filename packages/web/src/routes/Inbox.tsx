import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ChangeKind, Program, ReviewDecision } from '@grantspotter/core';
import { parseObservedWindow } from '@grantspotter/core';
import { ApiError, apiSend } from '../api/client.js';
import { useApi } from '../store/useApi.js';
import { formatDate } from '../lib/trust.js';
import { blockedHostFor } from '../lib/safety.js';
// The record page's reader, imported rather than restated. `cc64182` split `DeadlineSpec.note`
// into the half a person can read and the machine directive in front of it for `Opportunity.tsx`;
// this screen prints the SAME field and kept printing the whole string. Two readers for one string
// is how the two surfaces came to disagree in the first place, so there is one.
import { deadlineKindWords, joinDeadlineNote, readDeadlineNote } from '../lib/programWords.js';
import { StatusPill } from '../components/StatusPill.js';
import { TrustBadge } from '../components/TrustBadge.js';
import '../components/inbox.css';

/** The change event a review item hangs off, as `GET /api/inbox` serialises it. */
export interface InboxChangeEvent {
  id: string;
  sourceId: string;
  programId: string | null;
  kind: ChangeKind;
  before: string | null;
  after: string | null;
  detectedAt: string;
  fieldPath: string | null;
}

/** One row of `GET /api/inbox`. Mirrors `InboxRow` in `server/src/api/inboxRouter.ts`. */
export interface InboxRow {
  id: string;
  decision: ReviewDecision;
  decidedBy: string | null;
  decidedAt: string | null;
  confidence: number;
  rejectKey: string | null;
  candidate: Program;
  changeEvent: InboxChangeEvent | null;
}

export interface InboxResponse {
  rows: InboxRow[];
  canDecide: boolean;
}

/**
 * `GET /api/inbox` returns at most this many rows and does NOT page — the cap
 * exists so a runaway source cannot turn one GET into a megabyte of JSON, and it
 * sits far above any real night's queue (706 change events produced 148 queued
 * items on the last crawl into an empty database). The number is restated here
 * for the same reason `api/client.ts` restates `ApiErrorCode`: import direction
 * is one-way and `web` may never import `server`. Its only use is to stop this
 * page reporting the cap as if it were the size of the queue.
 */
export const QUEUE_CAP = 500;

/**
 * Below this, `confidenceFor` was guessing rather than reading.
 *
 * 0.5 is where the lowest source tier's base sits (`TIER_CONFIDENCE.B`) and where the federal
 * sources' adjacency threshold of 6 lands once it is divided by 12. `parse_yield_dropped` is
 * 0.1 and a `vanished` on tier B is 0.3 — the two kinds where a reviewer most needs to look at
 * the payload rather than the headline.
 */
export const LOW_CONFIDENCE = 0.5;

/**
 * What the page says about how much of the queue it is showing.
 *
 * At the cap the sentence changes shape rather than the number: "500 review
 * items" would be a claim about the queue, and the one thing this page knows at
 * that point is that it has NOT been told how many there are.
 */
export function queueSummary(rows: readonly { decision: ReviewDecision }[]): string {
  const pending = rows.filter((r) => r.decision === 'pending').length;
  const waiting = `${String(pending)} waiting for a decision.`;
  if (rows.length >= QUEUE_CAP) {
    return (
      `The newest ${String(QUEUE_CAP)} review items — that is this API's cap, not a count of ` +
      `the queue, which may hold more. ${waiting}`
    );
  }
  const noun = rows.length === 1 ? 'review item' : 'review items';
  return `${String(rows.length)} ${noun} loaded · ${waiting}`;
}

/**
 * A change event's `before`/`after`, as something a person can read.
 *
 * BRIEF DEVIATION, and the defect it closes. The brief's fixture has these two
 * fields carrying short human strings — `'January 31'` → `'December 30, 12:00 PM
 * EST'` — and its implementation renders them raw. `diff/index.ts` writes
 * OBJECTS for four of the six kinds it emits: `deadline_changed` carries the
 * whole `DeadlineSpec`, `amount_changed` the whole `AmountSpec`,
 * `eligibility_changed` the entire `Constraint[]`, and `new`/`vanished` the
 * entire `Program`. `inboxRouter`'s `text()` hands anything that is not a string
 * to `JSON.stringify`. So the brief's markup renders a wall of braces per row —
 * and on a first crawl, where nearly every one of the queued items is a `new`,
 * every row would be a serialised Program. A queue nobody can read is a queue
 * whose reviewer approves without reading, which is the failure this screen
 * exists to prevent.
 *
 * Nothing is dropped: whenever this summarises, the row also offers the exact
 * payload it summarised from.
 */
export function describeChangeValue(raw: string | null, fieldPath: string | null): string | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw; // a plain string payload — `trust.status`, `rawOtherText`
  }
  if (typeof parsed !== 'object' || parsed === null) return raw;

  if (Array.isArray(parsed)) {
    const noun = fieldPath === 'constraints' ? 'eligibility rules' : 'entries';
    return `${String(parsed.length)} ${noun}`;
  }

  const record = parsed as Record<string, unknown>;
  // DeadlineSpec: the note is the sentence a human wrote or the parser read — MINUS the `RECUR`
  // directive, which is neither. `deadline_changed` carries the whole spec (`diff/index.ts` sets
  // `before: prevProgram.deadline`), so this branch was the second of the two places this screen
  // printed the directive at a member, once on each side of the arrow. `record.kind` is likewise
  // a storage identifier and not a word, so the empty-note fallback goes through the same table
  // the calendar's undated list uses.
  if (typeof record.note === 'string' && typeof record.kind === 'string') {
    const read = readDeadlineNote(record.note);
    if (read.prose !== '') return read.prose;
    if (read.rule !== undefined) return read.rule;
    return deadlineKindWords(record.kind);
  }
  // AmountSpec.
  if (typeof record.amountRaw === 'string') {
    return record.amountRaw !== '' ? record.amountRaw : String(record.instrument);
  }
  // A whole Program — `new` and `vanished`.
  if (typeof record.name === 'string') return record.name;
  return raw.length > 160 ? `${raw.slice(0, 160)}…` : raw;
}

/**
 * THE WINDOW A FUNDER STATED, ABOUT TO STOP BEING STATED — or `null` when this edit leaves it
 * alone.
 *
 * The `RECUR` directive is not the only load-bearing thing inside `DeadlineSpec.note`. Core's
 * `parseObservedWindow` reads `opens YYYY-MM-DD` / `closes YYYY-MM-DD` back out of the sentence
 * after `published by the funder:`, and `observedCycles` turns that into the one cycle on the
 * whole calendar marked `isEstimated: false` — the single date this product says a funder itself
 * printed. It is PROSE, so unlike the directive it belongs in the box and an administrator may
 * genuinely have to correct it. What it may not do is leave without being mentioned.
 *
 * So this is a warning and not a refusal, and it is worded as the question it actually is. The
 * dates come from core's parser, never from a regex written here: a warning that disagreed with
 * the reader about which window is stored would be worse than no warning.
 */
export function statedWindowLoss(storedNote: string, draftProse: string): string | null {
  const before = parseObservedWindow(storedNote);
  if (before === undefined) return null;
  const after = parseObservedWindow(draftProse);
  if (after !== undefined && after.opensAt === before.opensAt && after.closesAt === before.closesAt) {
    return null;
  }

  const say = (w: { opensAt?: string; closesAt?: string }): string =>
    [
      w.opensAt === undefined ? null : `opens ${w.opensAt}`,
      w.closesAt === undefined ? null : `closes ${w.closesAt}`,
    ]
      .filter((part): part is string => part !== null)
      .join(', ');

  const stored = `GrantSpotter reads a window the funder itself published out of this note (${say(
    before,
  )}) and puts it on the calendar as the one date on it nobody projected.`;
  return after === undefined
    ? `${stored} These sentences no longer state it, so saving removes that date. Right if the ` +
        `funder withdrew the window; wrong if you were tidying the wording.`
    : `${stored} These sentences now state ${say(after)} instead, so saving moves that date.`;
}

/**
 * Whether the candidate is a record a reader can open.
 *
 * A `new` candidate is not in the corpus until it is approved, and an approved
 * `vanished` candidate has been DELETED from it — linking either one sends the
 * reviewer to a "not found" page and teaches them that this screen's links are
 * unreliable. An edit always upserts, whatever the event kind, so an edited row
 * is present even when the event said the record had gone.
 */
export type CorpusState = 'present' | 'not_yet' | 'removed' | 'unknown';

export function corpusState(row: InboxRow): CorpusState {
  if (row.changeEvent === null) return 'unknown';
  if (row.decision === 'edited') return 'present';
  if (row.changeEvent.kind === 'vanished') return row.decision === 'approved' ? 'removed' : 'present';
  if (row.changeEvent.kind === 'new') return row.decision === 'approved' ? 'present' : 'not_yet';
  return 'present';
}

/**
 * What a decision DID, in the corpus's terms.
 *
 * The API answers a decision with `published: true` whenever the corpus was
 * written — and for an approved `vanished` event that write was a DELETION. So
 * the word "published" is never used here: it would state the opposite of what
 * happened to the one record where getting it wrong matters most.
 *
 * The reject sentence describes the server's suppression, not a key this page
 * composed. A browser-composed reject key is not the key `buildReviewItems`
 * looks memory up under, which is why this page sends none.
 */
export function outcomeSentence(decision: ReviewDecision, kind: ChangeKind | null): string | null {
  switch (decision) {
    case 'pending':
      return null;
    case 'rejected':
      return 'Rejected. The candidate is remembered as refused, so a later crawl will not queue it again.';
    case 'edited':
      return 'Edited by hand and written to the corpus.';
    case 'approved':
      return kind === 'vanished'
        ? 'Approved — the record was removed from the corpus, because the source no longer carries it.'
        : 'Approved and written to the corpus.';
  }
}

/**
 * What to tell a reviewer whose decision did not land. Deliberately not one
 * sentence for everything: a `conflict` explains itself (`do_not_publish` is the
 * backstop standing between 37 already-funded clubs and a browse list that
 * presents them as open opportunities), and a transport failure must not be
 * reported as a refusal — the decision simply was not recorded.
 */
export function messageFor(err: unknown): string {
  if (!(err instanceof ApiError) || err.status === 0) {
    return 'The GrantSpotter API could not be reached, so this decision was not recorded. Try again.';
  }
  switch (err.code) {
    case 'conflict':
    case 'validation_failed':
      return err.message;
    case 'forbidden':
      return 'Your account cannot decide review items. Only an administrator can.';
    case 'not_found':
      return 'That review item is no longer in the queue. Reload the page to see its current state.';
    default:
      return `The server answered ${String(err.status)} and did not record this decision: ${err.message}`;
  }
}

interface Panel {
  rowId: string;
  mode: 'edit' | 'reject';
}

export function Inbox(): JSX.Element {
  const { data, loading, error, reload } = useApi<InboxResponse>('/api/inbox');
  const [showAll, setShowAll] = useState(false);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [draftNote, setDraftNote] = useState('');
  const [draftReason, setDraftReason] = useState('');
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  // Rows the server has already accepted a decision for. Approving twice is not
  // harmless — the second POST re-runs the corpus write and the notify drain
  // against a row that is no longer pending — and neither `disabled` nor the
  // reload closes the window on its own: `disabled` needs a repaint, and the
  // second click of a double-click lands before the reload has answered. Once
  // the API has said yes, this row is not pending whatever the stale list says.
  const [settled, setSettled] = useState<Record<string, true>>({});
  // Belt to those braces, for two decisions genuinely in flight at once.
  const inFlight = useRef<string | null>(null);

  const rows = data?.rows ?? [];
  const visible = showAll ? rows : rows.filter((row) => row.decision === 'pending');

  async function decide(
    row: InboxRow,
    decision: Exclude<ReviewDecision, 'pending'>,
  ): Promise<void> {
    if (inFlight.current !== null) return;
    inFlight.current = row.id;
    setBusyId(row.id);
    setFailures((current) => {
      const next = { ...current };
      delete next[row.id];
      return next;
    });

    // NO `rejectKey`. The server derives it with Plan 2's `rejectKeyFor` — a
    // sha256 over `sourceId|program.id|hashProgram(program)` — because that is
    // the only key `buildReviewItems` ever looks reject memory up under. A key
    // composed in a browser suppresses nothing and the candidate returns on the
    // next crawl, with no signal that the rejection failed.
    const body: Record<string, unknown> = { decision };
    if (decision === 'rejected' && draftReason.trim() !== '') body.reason = draftReason.trim();
    if (decision === 'edited') {
      // The whole candidate, not a fragment: the server revalidates it against
      // `programSchema` and 422s anything that is not a complete Program.
      //
      // `draftNote` IS THE PROSE ONLY. The directive is read off the stored candidate and rejoined
      // here, so the rule survives whatever the reviewer typed — and the reviewer was never handed
      // it to type over. The server checks the same thing again on its own (`inboxRouter`'s
      // recurrence guard), because a browser is not where a corpus invariant can be enforced.
      body.candidate = {
        ...row.candidate,
        deadline: {
          ...row.candidate.deadline,
          note: joinDeadlineNote({
            directive: readDeadlineNote(row.candidate.deadline.note).directive,
            prose: draftNote,
          }),
        },
      };
    }

    try {
      await apiSend('POST', `/api/inbox/${row.id}/decision`, body);
      setSettled((current) => ({ ...current, [row.id]: true }));
      setPanel(null);
      // Re-read rather than patching the row locally: the decision moved the
      // corpus, and what this queue now says about it is the server's to state.
      reload();
    } catch (err: unknown) {
      setFailures((current) => ({ ...current, [row.id]: messageFor(err) }));
    } finally {
      inFlight.current = null;
      setBusyId(null);
    }
  }

  function openPanel(row: InboxRow, mode: 'edit' | 'reject'): void {
    setPanel({ rowId: row.id, mode });
    // The PROSE, not the note. What the box holds is what Save writes back, so a box pre-filled
    // with the directive is a box in which deleting the directive is one keystroke and looks like
    // tidying — which is what an administrator was invited to do by a panel labelled only
    // "Deadline note".
    setDraftNote(readDeadlineNote(row.candidate.deadline.note).prose);
    setDraftReason('');
  }

  return (
    <>
      <p className="eyebrow">Review queue</p>
      <h1 style={{ marginBottom: 'var(--s-4)' }}>Inbox</h1>

      {data !== null && !data.canDecide && (
        <div className="inbox-note" role="note">
          <p>
            This queue is read-only for your account: only an administrator can approve or reject a
            change.
          </p>
          <p>
            Nothing here is hidden from you, and nothing has gone wrong. A pending row is a change
            GrantSpotter has detected in a funder&rsquo;s page but has not yet trusted — and knowing
            that a deadline on a programme you watch is under review is worth more than a list that
            quietly disagrees with the funder.
          </p>
        </div>
      )}

      {loading && <p className="eyebrow">Loading…</p>}
      {error !== null && (
        <p role="alert" className="inbox-error">
          {error.status === 0
            ? 'The GrantSpotter API could not be reached, so the review queue is not shown. It is not empty — it is unknown.'
            : `The review queue could not be loaded: ${error.message}`}
        </p>
      )}

      {data !== null && (
        <>
          {rows.length > 0 && <p className="inbox-summary">{queueSummary(rows)}</p>}
          <div className="inbox-filter" role="group" aria-label="Which review items to show">
            <button
              type="button"
              className="btn"
              aria-pressed={!showAll}
              onClick={() => {
                setShowAll(false);
              }}
            >
              Waiting
            </button>
            <button
              type="button"
              className="btn"
              aria-pressed={showAll}
              onClick={() => {
                setShowAll(true);
              }}
            >
              All
            </button>
          </div>
        </>
      )}

      <div className="inbox">
        {data !== null && visible.length === 0 && (
          <p>
            Nothing is waiting for review.
            {!showAll && rows.length > 0 && ' Decided items are under “All”.'}
          </p>
        )}

        {visible.map((row) => {
          const event = row.changeEvent;
          const place = corpusState(row);
          const outcome = outcomeSentence(row.decision, event?.kind ?? null);
          const failure = failures[row.id];
          const recorded = settled[row.id] === true;
          const decidable = data?.canDecide === true && row.decision === 'pending' && !recorded;
          const blockedHost =
            blockedHostFor(row.candidate.applyUrl) ?? blockedHostFor(row.candidate.trust.sourceUrl);
          const isSafetyWarning = row.candidate.tags.includes('safety_warning');
          const beforeText = describeChangeValue(event?.before ?? null, event?.fieldPath ?? null);
          const afterText = describeChangeValue(event?.after ?? null, event?.fieldPath ?? null);
          const summarised =
            (event?.before != null && beforeText !== event.before) ||
            (event?.after != null && afterText !== event.after);

          return (
            <article
              key={row.id}
              className={`card${row.decision === 'pending' ? '' : ' inbox-decided'}`}
              aria-label={row.candidate.name}
            >
              <div>
                <p className="eyebrow">
                  {(event?.kind ?? 'candidate').replace(/_/g, ' ')} · {row.decision}
                </p>
                <h2 className="inbox-title">
                  {place === 'present' ? (
                    <Link to={`/o/${row.candidate.id}`}>{row.candidate.name}</Link>
                  ) : (
                    row.candidate.name
                  )}
                </h2>
                {place === 'not_yet' && (
                  <p className="inbox-outcome">
                    Not in the corpus yet — nobody can see this record until it is approved.
                  </p>
                )}
              </div>

              {/*
                Two different facts, worded separately because they are not the same fact.
                `farweb.org` is blocklisted for SAFETY — the Foundation for Amateur Radio's
                domain was taken over and now serves a gambling site, while ARRL, QCWA and club
                pages still say "apply at the FAR website" — and the corpus's warning record
                exists to intercept that instruction. The commercial aggregators on the same
                list are blocked for licence reasons, and telling a reviewer not to visit one of
                those would be a false alarm.
              */}
              {(isSafetyWarning || blockedHost !== null) && (
                <p className="inbox-safety" role="alert">
                  {isSafetyWarning && 'Safety warning. Do not visit the domain named in this record. '}
                  {blockedHost !== null && (
                    <>
                      GrantSpotter never links to <span className="data">{blockedHost}</span>, which
                      this candidate points at, so any URL on that host is shown here as text and
                      not as a link.{' '}
                    </>
                  )}
                  {isSafetyWarning && row.candidate.summary}
                </p>
              )}

              {event !== null && (event.before !== null || event.after !== null) && (
                <>
                  <p className="inbox-move">
                    {beforeText !== null && <span className="inbox-was">{beforeText}</span>}
                    {beforeText !== null && afterText !== null && <span aria-hidden="true">→</span>}
                    {afterText !== null && <span className="inbox-now">{afterText}</span>}
                  </p>
                  {summarised && (
                    <details>
                      <summary>The exact payload this was summarised from</summary>
                      <pre className="data inbox-raw">
                        {`before: ${event.before ?? '—'}\nafter:  ${event.after ?? '—'}`}
                      </pre>
                    </details>
                  )}
                </>
              )}

              <div className="inbox-meta">
                {event !== null && (
                  <>
                    <span>
                      Source <span className="data">{event.sourceId}</span>
                    </span>
                    <span>
                      Detected <span className="data">{formatDate(event.detectedAt)}</span>
                    </span>
                    {event.fieldPath !== null && (
                      <span>
                        Field <span className="data">{event.fieldPath}</span>
                      </span>
                    )}
                  </>
                )}
                <span>
                  Confidence <span className="data">{row.confidence.toFixed(2)}</span>
                  {row.confidence < LOW_CONFIDENCE && ' — low, read the payload'}
                </span>
                <StatusPill status={row.candidate.trust.status} />
                <TrustBadge lastVerifiedAt={row.candidate.trust.lastVerifiedAt} />
                {row.decidedBy !== null && (
                  <span>
                    Decided by <span className="data">{row.decidedBy}</span>
                    {row.decidedAt !== null && (
                      <>
                        {' on '}
                        <span className="data">{formatDate(row.decidedAt)}</span>
                      </>
                    )}
                  </span>
                )}
              </div>

              {/*
                THE MACHINE DIRECTIVE STOPS HERE. This screen is read-only for members BY DESIGN
                — `inboxRouter`'s GET is `requireAuth`, not `requireAdmin`, because knowing a
                deadline is under review is trust information — so `row.candidate.deadline.note`
                printed raw put "RECUR annual_window tz=America/New_York window=10-30..12-30" in
                front of a student, on the same corpus and in the same words the record page had
                just stopped doing it in.

                Each half gets its own line rather than one joined sentence: the rule is derived
                and the prose is the funder's, and a reader deciding whether to trust a date needs
                to know which of the two they are looking at.
              */}
              {(() => {
                const note = readDeadlineNote(row.candidate.deadline.note);
                return (
                  <>
                    {note.prose !== '' && (
                      <p className="inbox-outcome">Deadline note: {note.prose}</p>
                    )}
                    {note.rule !== undefined && (
                      <p className="inbox-outcome">Repeats: {note.rule}</p>
                    )}
                    {note.directive !== undefined && note.rule === undefined && (
                      <p className="inbox-outcome">
                        This candidate carries a repeat rule GrantSpotter cannot read, so it
                        projects no dates from it.
                      </p>
                    )}
                  </>
                );
              })()}

              {row.candidate.applyUrl !== undefined && (
                <p className="inbox-outcome">
                  Apply at{' '}
                  {blockedHostFor(row.candidate.applyUrl) === null ? (
                    // `source-url` for the same reason `SourceLink`'s anchor carries it: a
                    // candidate's address is one unbreakable word, and a review queue is where the
                    // longest untidiest URLs in the corpus arrive. The refused arm below is
                    // covered by `.data`, which now breaks the same way.
                    <a
                      className="source-url"
                      href={row.candidate.applyUrl}
                      rel="noreferrer noopener"
                      target="_blank"
                    >
                      {row.candidate.applyUrl}
                    </a>
                  ) : (
                    <span className="data">{row.candidate.applyUrl}</span>
                  )}
                </p>
              )}

              {outcome !== null && <p className="inbox-outcome">{outcome}</p>}

              {recorded && row.decision === 'pending' && (
                <p className="inbox-outcome">
                  Decision recorded. This row still reads as pending because the queue has not
                  reloaded yet.
                </p>
              )}

              {failure !== undefined && (
                <p role="alert" className="inbox-error">
                  {failure}
                </p>
              )}

              {decidable && (
                <>
                  <div className="inbox-actions">
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={busyId !== null}
                      onClick={() => {
                        void decide(row, 'approved');
                      }}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      className="btn"
                      disabled={busyId !== null}
                      onClick={() => {
                        openPanel(row, 'reject');
                      }}
                    >
                      Reject
                    </button>
                    <button
                      type="button"
                      className="btn"
                      disabled={busyId !== null}
                      onClick={() => {
                        openPanel(row, 'edit');
                      }}
                    >
                      Edit
                    </button>
                  </div>

                  {panel?.rowId === row.id && panel.mode === 'edit' && (() => {
                    const stored = readDeadlineNote(row.candidate.deadline.note);
                    const windowLoss = statedWindowLoss(row.candidate.deadline.note, draftNote);
                    return (
                    <div className="inbox-panel">
                      {/*
                        THE RULE IS SHOWN AND NOT OFFERED. It used to be pre-filled into the box
                        below, under a label that said only "Deadline note", beside a hint that
                        said the note was the editable part — so an administrator who deleted the
                        `RECUR …|` prefix and kept the sentence, which is exactly what tidying a
                        note looks like, deleted the rule that generates every future date for the
                        programme. Measured on the shipped corpus: one such save took the ARRL
                        Foundation record's projected dates from 2 to 0 and, because 112 records
                        inherit that deadline, the corpus's cycle table from 243 rows to 17.

                        Showing it read-only is the point of the panel, not decoration: the
                        requirement is that nobody can silently delete a rule they were never
                        shown, and both halves of that are load-bearing.
                      */}
                      {stored.directive !== undefined && (
                        <div className="inbox-rule">
                          <p className="inbox-rule-head">
                            Repeat rule — kept exactly as it is, and not editable here
                          </p>
                          <p>
                            {stored.rule ??
                              'GrantSpotter cannot read this rule, so it projects no dates from it. It is kept anyway, unchanged.'}
                          </p>
                          <p className="data inbox-rule-raw">{stored.directive}</p>
                          <p className="inbox-hint">
                            This is what GrantSpotter reads to generate every future date it
                            publishes for this programme, including for any record that inherits
                            this deadline. It travels with your edit unchanged, and the server
                            refuses an edit that changes it. A rule that is wrong is a fix to the
                            source.
                          </p>
                        </div>
                      )}
                      <label htmlFor={`inbox-note-${row.id}`}>
                        Deadline note — the funder&rsquo;s own sentences
                      </label>
                      <textarea
                        id={`inbox-note-${row.id}`}
                        value={draftNote}
                        onChange={(e) => {
                          setDraftNote(e.target.value);
                        }}
                      />
                      <p className="inbox-hint">
                        Only these sentences are editable here. Anything else wrong with this
                        record is a fix to its source, not to one queued candidate.
                      </p>
                      {windowLoss !== null && (
                        <p role="alert" className="inbox-safety">
                          {windowLoss}
                        </p>
                      )}
                      <div className="inbox-actions">
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={busyId !== null}
                          onClick={() => {
                            void decide(row, 'edited');
                          }}
                        >
                          Save and approve
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => {
                            setPanel(null);
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                    );
                  })()}

                  {panel?.rowId === row.id && panel.mode === 'reject' && (
                    <div className="inbox-panel">
                      <label htmlFor={`inbox-reason-${row.id}`}>
                        Why? (recorded in the audit trail)
                      </label>
                      <textarea
                        id={`inbox-reason-${row.id}`}
                        value={draftReason}
                        onChange={(e) => {
                          setDraftReason(e.target.value);
                        }}
                      />
                      <p className="inbox-hint">
                        Rejecting also tells the crawler to stop offering this exact candidate. The
                        suppression key is derived on the server from the source and the record
                        itself, so it matches what the next crawl computes.
                      </p>
                      <div className="inbox-actions">
                        <button
                          type="button"
                          className="btn"
                          disabled={busyId !== null}
                          onClick={() => {
                            void decide(row, 'rejected');
                          }}
                        >
                          Confirm rejection
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => {
                            setPanel(null);
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </article>
          );
        })}
      </div>
    </>
  );
}
