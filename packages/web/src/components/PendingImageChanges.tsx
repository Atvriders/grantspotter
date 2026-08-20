import { useMemo, useState } from 'react';
import { apiSend, ApiError } from '../api/client.js';
import { useApi } from '../store/useApi.js';

/**
 * THE SECOND DOOR ON A SHIPPED-DATA CORRECTION, AS A SCREEN.
 *
 * At every boot GrantSpotter reconciles this deployment's records against the corpus in the image
 * it is running. It rewrites a field only when the bytes it holds are byte-for-byte the text this
 * project shipped, and only when the rewrite changes what the record SAYS and not what it MEANS.
 * Everything else it computes, reports, and throws away — which is right for a boot, and is why a
 * correct fix to an eligibility rule can be in the image for a fortnight and never reach a single
 * student.
 *
 * This panel is where those refusals go. It shows what each one would move — the rule, field by
 * field; the funder's own sentence behind it; the deadline it shifts; and how many of THIS
 * instance's saved applicant profiles change verdict — and applies only what an administrator
 * ticks and confirms.
 *
 * IT IS NOT A "3 CHANGES PENDING — APPLY?" BUTTON, and the difference is the whole point. Consent
 * to a count is not consent. Each row carries the sentence and the movement, each apply names the
 * exact changes it consented to by a digest of their contents, and the server refuses an id whose
 * proposal has moved since it was read.
 *
 * ADDING A PROGRAMME IS A SEPARATE LIST WITH A SEPARATE CONFIRMATION, because it is a separate
 * act: nothing is being put right, a record appears in front of members that was not there before,
 * and the operator may have removed it deliberately. The corrections button cannot carry one — the
 * server refuses it by kind, not merely this page.
 */

/* Mirrors the server's `PendingChanges` (packages/server/src/seed/consentedCorrections.ts).
   Restated rather than imported: the import direction is `web → core` only. */

interface VerdictMove {
  before: string;
  after: string;
  count: number;
}

interface ProfileImpact {
  profilesMeasured: number;
  moves: VerdictMove[];
}

interface RuleFieldChange {
  field: string;
  before: string | null;
  after: string | null;
}

interface RuleChange {
  constraintId: string;
  change: 'added' | 'dropped' | 'changed';
  sentence: string;
  fields: RuleFieldChange[];
}

interface DeadlineMove {
  before: string;
  after: string;
  observedBefore: string | null;
  observedAfter: string | null;
  nextCloseBefore: string | null;
  nextCloseAfter: string | null;
  inheritedBy: number;
}

interface ProposalBase {
  id: string;
  programId: string;
  programName: string;
  funderName: string;
  sourceUrl: string;
  impact: ProfileImpact;
}

interface WordingProposal extends ProposalBase {
  kind: 'wording';
  path: string;
  from: string;
  to: string;
  fromFirstSeen: string;
  deadline?: DeadlineMove;
}

interface RulesProposal extends ProposalBase {
  kind: 'rules';
  changes: RuleChange[];
}

interface RecordProposal extends ProposalBase {
  kind: 'record';
  summary: string;
  klass: string;
  applyUrl: string | null;
  amountRaw: string;
  deadlineNote: string;
  constraintCount: number;
  addsFunder: string | null;
}

interface NotOffered {
  programId: string;
  path: string;
  reason: string;
  why: string;
}

interface PendingChanges {
  ran: boolean;
  wording: WordingProposal[];
  rules: RulesProposal[];
  additions: RecordProposal[];
  notOffered: NotOffered[];
  profilesMeasured: number;
  examined: number;
  ledgerSize: number;
  error?: string;
}

interface AppliedChange {
  id: string;
  kind: string;
  programId: string;
  programName: string;
  what: string;
}

interface RefusedChange {
  id: string;
  why: string;
}

interface ConsentResult {
  ran: boolean;
  applied: AppliedChange[];
  refused: RefusedChange[];
  programsReindexed: number | null;
}

/** The two words, and they are different words because they are different acts. */
export const CONFIRM_CORRECT = 'CORRECT';
export const CONFIRM_ADD = 'ADD';

function plural(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/**
 * The measured movement, as a sentence, INCLUDING WHEN THERE IS NOTHING TO MEASURE.
 *
 * An instance with no applicant profiles saved on it gets told exactly that, rather than a blank
 * space or an invented student. This project has already paid once for an instrument that reported
 * against a population that did not exist, and the lesson recorded in `scripts/profile-corpus.ts`
 * is that an over-reporting measurement is worse than none, because it manufactures confidence.
 */
function ImpactLine({ impact }: { impact: ProfileImpact }): JSX.Element {
  if (impact.profilesMeasured === 0) {
    return (
      <p className="pending-impact pending-impact-none">
        No applicant profile is saved on this instance, so no verdict movement could be measured.
        Decide on the change itself, above.
      </p>
    );
  }
  if (impact.moves.length === 0) {
    return (
      <p className="pending-impact">
        No verdict moves: all {plural(impact.profilesMeasured, 'applicant profile', 'applicant profiles')} saved
        here are told the same thing before and after.
      </p>
    );
  }
  return (
    <ul className="pending-impact pending-impact-moves">
      {impact.moves.map((move) => (
        <li key={`${move.before}-${move.after}`}>
          <strong>
            {String(move.count)} of {String(impact.profilesMeasured)}
          </strong>{' '}
          applicant {impact.profilesMeasured === 1 ? 'profile' : 'profiles'} saved here: today this
          record tells them <em>{move.before}</em>; afterwards it tells them <em>{move.after}</em>.
        </li>
      ))}
    </ul>
  );
}

function RuleChangeBlock({ change }: { change: RuleChange }): JSX.Element {
  const verb =
    change.change === 'added'
      ? 'a requirement the image ADDS'
      : change.change === 'dropped'
        ? 'a requirement the image REMOVES'
        : 'a requirement the image CHANGES';
  return (
    <div className="pending-rule">
      <p className="eyebrow">
        {verb} — {change.constraintId}
      </p>
      {change.sentence === '' ? (
        <p className="pending-quote pending-quote-empty">
          No funder sentence is recorded against this requirement.
        </p>
      ) : (
        <blockquote className="pending-quote">{change.sentence}</blockquote>
      )}
      <ul className="pending-fields">
        {change.fields.map((field) => (
          <li key={field.field}>
            <code>{field.field}</code>{' '}
            <span className="pending-from">{field.before ?? 'not set'}</span> →{' '}
            <span className="pending-to">{field.after ?? 'not set'}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DeadlineBlock({ move }: { move: DeadlineMove }): JSX.Element {
  return (
    <ul className="pending-fields">
      <li>
        Repeat rule <span className="pending-from">{move.before}</span> →{' '}
        <span className="pending-to">{move.after}</span>
      </li>
      <li>
        Next projected close{' '}
        <span className="pending-from">{move.nextCloseBefore ?? 'none projected'}</span> →{' '}
        <span className="pending-to">{move.nextCloseAfter ?? 'none projected'}</span>
      </li>
      {(move.observedBefore !== null || move.observedAfter !== null) && (
        <li>
          Funder-stated window{' '}
          <span className="pending-from">{move.observedBefore ?? 'none stated'}</span> →{' '}
          <span className="pending-to">{move.observedAfter ?? 'none stated'}</span>
        </li>
      )}
      {move.inheritedBy > 0 && (
        <li>
          {move.inheritedBy === 1
            ? 'One other record takes its deadline from this one and moves with it.'
            : `${String(move.inheritedBy)} other records take their deadline from this one and move with it.`}
        </li>
      )}
    </ul>
  );
}

export function PendingImageChanges(): JSX.Element {
  const pending = useApi<PendingChanges>('/api/admin/seed-corrections');
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const [correctWord, setCorrectWord] = useState('');
  const [addWord, setAddWord] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const data = pending.data;
  const corrections = useMemo<Array<WordingProposal | RulesProposal>>(
    () => [...(data?.wording ?? []), ...(data?.rules ?? [])],
    [data],
  );
  const additions = data?.additions ?? [];

  const pickedCorrections = corrections.filter((p) => chosen[p.id] === true).map((p) => p.id);
  const pickedAdditions = additions.filter((p) => chosen[p.id] === true).map((p) => p.id);

  const movesVerdict = corrections.filter((p) => p.impact.moves.length > 0).length;

  function toggle(id: string): void {
    setChosen((current) => ({ ...current, [id]: current[id] !== true }));
  }

  async function send(path: string, confirm: string, ids: string[]): Promise<void> {
    setError(null);
    setNotice(null);
    try {
      const result = await apiSend<ConsentResult>('POST', path, { confirm, proposalIds: ids });
      const applied = result.applied
        .map((a) => `${a.programName} (${a.programId}) — ${a.what}`)
        .join('. ');
      const refused = result.refused.map((r) => r.why).join(' ');
      const reindexed =
        result.programsReindexed === null
          ? ''
          : ` The browse index was rebuilt for ${plural(result.programsReindexed, 'programme', 'programmes')}.`;
      setNotice(
        `${plural(result.applied.length, 'change', 'changes')} applied${applied === '' ? '' : `: ${applied}`}.` +
          `${refused === '' ? '' : ` ${plural(result.refused.length, 'change was', 'changes were')} refused: ${refused}`}` +
          `${reindexed} Every one of them is in the audit log with the whole of the text it replaced.`,
      );
      setChosen({});
      setCorrectWord('');
      setAddWord('');
      pending.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That change could not be applied.');
    }
  }

  return (
    <section className="admin-section card" aria-label="Pending changes from the image">
      <h2>Pending changes from the image</h2>
      <p className="admin-prose">
        Every time this server starts it compares its records against the corpus in the image it is
        running, and it corrects a field only when two things are both true: the text it holds is
        byte-for-byte what GrantSpotter shipped, so no edit of yours is overwritten; and the
        correction changes what the record <em>says</em> and not what it <em>means</em>. A change
        that would move a deadline, an amount or an eligibility answer is refused at boot and listed
        here instead, because a restart must never quietly change who is told they are eligible.
      </p>
      <p className="admin-prose">
        You can change it. Read what each one moves, tick the ones you accept, and confirm. Nothing
        below is applied by ticking alone, the exact text that is replaced is written to the audit
        log first, and a field that is not provably GrantSpotter’s own is never offered here at all
        — consent lets you change what a record means, it does not let this image overwrite
        somebody’s work.
      </p>

      {pending.loading && <p className="eyebrow">Reading the image…</p>}

      {pending.error !== null && (
        <p role="alert" className="admin-alert">
          Could not read the pending changes ({pending.error.code}). {pending.error.message}
        </p>
      )}

      {error !== null && (
        <p role="alert" className="admin-alert">
          {error}
        </p>
      )}

      {notice !== null && (
        <p role="status" className="admin-notice">
          {notice}
        </p>
      )}

      {data !== null && !data.ran && (
        <p role="alert" className="admin-alert">
          The comparison could not be run, so nothing is offered and nothing was written:{' '}
          {data.error ?? 'unknown error'}
        </p>
      )}

      {data !== null && data.ran && (
        <>
          <p className="admin-prose">
            {plural(data.examined, 'shipped record', 'shipped records')} checked against{' '}
            {plural(data.ledgerSize, 'recorded value', 'recorded values')}.{' '}
            {corrections.length === 0 && additions.length === 0
              ? 'Nothing is outstanding: this deployment already holds everything the image would change.'
              : `${plural(corrections.length, 'correction is', 'corrections are')} waiting, ${String(movesVerdict)} of which move a verdict for somebody with a profile here, and ${plural(additions.length, 'programme', 'programmes')} would be added.`}
          </p>
          <p className="admin-prose">
            {data.profilesMeasured === 0
              ? 'No applicant profile is saved on this instance, so no movement below could be measured against a real person. The rule changes themselves are shown in full.'
              : `Every movement below was measured by running the real matcher over the ${plural(data.profilesMeasured, 'applicant profile', 'applicant profiles')} saved on this instance, before and after. No applicant is invented and none is named.`}
          </p>

          {corrections.length > 0 && (
            <>
              <h3 className="pending-heading">Corrections this deployment is not making</h3>
              <ul className="pending-list" aria-label="Pending corrections">
                {corrections.map((proposal) => (
                  <li key={proposal.id} className="pending-item">
                    <label className="pending-choose">
                      <input
                        type="checkbox"
                        checked={chosen[proposal.id] === true}
                        onChange={() => toggle(proposal.id)}
                        aria-label={`Apply the ${proposal.kind === 'rules' ? 'eligibility rule change' : 'wording correction'} for ${proposal.programName}`}
                      />
                      <span>
                        <strong>{proposal.programName}</strong>
                        <span className="pending-meta">
                          {proposal.funderName} · {proposal.programId}
                        </span>
                      </span>
                    </label>

                    {proposal.kind === 'rules' &&
                      proposal.changes.map((change) => (
                        <RuleChangeBlock key={change.constraintId} change={change} />
                      ))}

                    {proposal.kind === 'wording' && (
                      <div className="pending-rule">
                        <p className="eyebrow">
                          text the image would replace — {proposal.path}, shipped{' '}
                          {proposal.fromFirstSeen}
                        </p>
                        <blockquote className="pending-quote pending-from">
                          {proposal.from}
                        </blockquote>
                        <blockquote className="pending-quote pending-to">{proposal.to}</blockquote>
                        {proposal.deadline !== undefined && (
                          <DeadlineBlock move={proposal.deadline} />
                        )}
                      </div>
                    )}

                    <ImpactLine impact={proposal.impact} />
                    <p className="pending-meta">
                      <a href={proposal.sourceUrl} rel="noreferrer noopener" target="_blank">
                        The page this record was read from
                      </a>
                    </p>
                  </li>
                ))}
              </ul>

              <div className="admin-form">
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    setChosen(Object.fromEntries(corrections.map((p) => [p.id, true])))
                  }
                >
                  Tick every correction
                </button>
                <label htmlFor="pending-confirm-correct">
                  Type {CONFIRM_CORRECT} to confirm
                  <input
                    id="pending-confirm-correct"
                    type="text"
                    autoComplete="off"
                    value={correctWord}
                    onChange={(e) => setCorrectWord(e.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className="btn"
                  disabled={correctWord !== CONFIRM_CORRECT || pickedCorrections.length === 0}
                  onClick={() => {
                    void send(
                      '/api/admin/seed-corrections/apply',
                      CONFIRM_CORRECT,
                      pickedCorrections,
                    );
                  }}
                >
                  Apply {plural(pickedCorrections.length, 'ticked correction', 'ticked corrections')}
                </button>
              </div>
            </>
          )}

          {additions.length > 0 && (
            <div className="pending-additions">
              <h3 className="pending-heading">Programmes the image would add</h3>
              <p className="admin-prose">
                These are not corrections. Nothing here is being put right: a programme that is not
                on this instance would appear in front of your members, and if you removed it
                deliberately, leaving it unticked is the answer. GrantSpotter does not remember that
                you declined, so a record you have removed on purpose will be listed here again
                after the next upgrade.
              </p>
              <ul className="pending-list" aria-label="Programmes the image would add">
                {additions.map((proposal) => (
                  <li key={proposal.id} className="pending-item">
                    <label className="pending-choose">
                      <input
                        type="checkbox"
                        checked={chosen[proposal.id] === true}
                        onChange={() => toggle(proposal.id)}
                        aria-label={`Add ${proposal.programName}`}
                      />
                      <span>
                        <strong>{proposal.programName}</strong>
                        <span className="pending-meta">
                          {proposal.funderName} · {proposal.programId} ·{' '}
                          {plural(proposal.constraintCount, 'requirement', 'requirements')}
                        </span>
                      </span>
                    </label>
                    <p className="pending-summary">{proposal.summary}</p>
                    {proposal.addsFunder !== null && (
                      <p className="pending-meta">
                        This also adds the funder {proposal.addsFunder}, which this instance does
                        not hold.
                      </p>
                    )}
                    <ImpactLine impact={proposal.impact} />
                  </li>
                ))}
              </ul>
              <div className="admin-form">
                <label htmlFor="pending-confirm-add">
                  Type {CONFIRM_ADD} to confirm
                  <input
                    id="pending-confirm-add"
                    type="text"
                    autoComplete="off"
                    value={addWord}
                    onChange={(e) => setAddWord(e.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className="btn"
                  disabled={addWord !== CONFIRM_ADD || pickedAdditions.length === 0}
                  onClick={() => {
                    void send('/api/admin/seed-corrections/add', CONFIRM_ADD, pickedAdditions);
                  }}
                >
                  Add {plural(pickedAdditions.length, 'ticked programme', 'ticked programmes')}
                </button>
              </div>
            </div>
          )}

          {data.notOffered.length > 0 && (
            <details className="pending-not-offered">
              <summary>
                {plural(data.notOffered.length, 'difference is', 'differences are')} not offered
                here at all
              </summary>
              <p className="admin-prose">
                The image and this deployment differ on these, and neither door will change them —
                not at boot, and not with your consent. They are listed so that what is above is a
                whole picture rather than a selection.
              </p>
              <ul className="pending-list">
                {data.notOffered.map((item) => (
                  <li key={`${item.programId}-${item.path}`} className="pending-item">
                    <strong>{item.programId}</strong> <code>{item.path}</code>
                    <p className="pending-meta">{item.why}</p>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}
