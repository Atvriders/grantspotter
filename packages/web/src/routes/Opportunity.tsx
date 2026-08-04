import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Cycle, Funder, ObligationState, Program, Verdict } from '@grantspotter/core';
import { obligationState } from '@grantspotter/core';
import { useApi } from '../store/useApi.js';
import { apiSend } from '../api/client.js';
import { VerdictBadge } from '../components/VerdictBadge.js';
import { TrustBadge } from '../components/TrustBadge.js';
import { StatusPill } from '../components/StatusPill.js';
import { DisputedPanel } from '../components/DisputedPanel.js';
import { IneligibilityDrawer } from '../components/IneligibilityDrawer.js';
import { ProvenanceTable, type FieldProvenance } from '../components/ProvenanceTable.js';
import { SourceLink } from '../components/SourceLink.js';
import { VerifyButton } from '../components/VerifyButton.js';
import { blockedHostFor } from '../lib/safety.js';
import { profileFieldHelp, profileFieldHref, profileFieldLabel } from '../lib/profileFields.js';
import { formatDate } from '../lib/trust.js';
import '../components/detail.css';

/** Mirrors `packages/server/src/api/browseTypes.ts`. Restated: `web` never imports `server`. */
interface OpportunityDetail {
  program: Program;
  funder: Funder;
  cycles: Cycle[];
  provenance: FieldProvenance[];
  verdict: Verdict | null;
  watched: boolean;
  deadlineOwner: { programId: string; programName: string } | null;
}

/** What a value the funder never stated renders as. Never an empty cell. */
const NOT_STATED = 'Not stated on the page.';

/**
 * The three readings of a tri-state obligation flag, in the words an applicant needs.
 *
 * CONTRACT §3 amendment 7 made `costShareRequired` and `coFunderPreference` optional because
 * ABSENCE IS NOT A NO. In this corpus `costShareRequired` reads unstated on 148 of the 150
 * published records and `false` on ZERO of them: no funder here has ever written down that cost
 * sharing is not required. The obvious `flag ? 'Required' : 'Not required'` would therefore have
 * published 148 claims nobody made — and a cost-share requirement discovered late is exactly what
 * makes an award unusable to a club with no matching funds. A blank prompts a check; a false
 * negative does not.
 *
 * The `switch` is over core's `ObligationState` union and is exhaustiveness-checked by tsc, so a
 * future edit that drops the unstated arm fails to compile rather than silently reverting to the
 * defect.
 */
function costShareCopy(state: ObligationState): string {
  switch (state) {
    case 'yes':
      return 'Required. You must contribute matching funds or in-kind value; budget for it before you apply.';
    case 'no':
      return 'The funder states that cost sharing is not required.';
    case 'unstated':
      return 'Not stated. No page this pipeline has fetched addresses cost sharing, so this is a question to put to the funder rather than an answer this product can give.';
  }
}

function coFunderCopy(state: ObligationState): string {
  switch (state) {
    case 'yes':
      return 'This funder prefers not to be the sole funder. Name your other funders in the application.';
    case 'no':
      return 'The funder states it has no preference about being the sole funder.';
    case 'unstated':
      return 'Not stated. Nothing fetched says whether this funder wants a co-funder alongside it.';
  }
}

/** Non-empty, or the honest placeholder. Never an empty cell (spec §8). */
function orNotStated(value: string): string {
  return value.trim() === '' ? NOT_STATED : value;
}

/**
 * Opportunity detail — spec §8's honesty surfaces in one place: the trust badge, every disputed
 * reading with its own source, the stale-mirror warning, `rawOtherText` verbatim, the quoted AI
 * policy, field-level provenance, and Verify now with its diff.
 */
export function Opportunity({ now }: { now?: string }): JSX.Element | null {
  const nowISO = now ?? new Date().toISOString();
  const { programId } = useParams();
  const { data, loading, error, reload } = useApi<OpportunityDetail>(
    programId !== undefined ? `/api/programs/${programId}` : null,
  );
  const [watched, setWatched] = useState<boolean | null>(null);
  const [watchError, setWatchError] = useState<string | null>(null);

  if (loading) return <p className="eyebrow">Loading…</p>;
  if (error) return <p role="alert">Could not load this record ({error.code}).</p>;
  if (!data) return null;

  const { program, funder, cycles, provenance, verdict, deadlineOwner } = data;
  const isWatched = watched ?? data.watched;
  const applyUrl = program.applyUrl ?? '';
  const applyBlocked = blockedHostFor(applyUrl);

  async function toggleWatch(): Promise<void> {
    setWatchError(null);
    try {
      if (isWatched) {
        await apiSend('DELETE', `/api/watches/${program.id}`);
        setWatched(false);
      } else {
        await apiSend('POST', '/api/watches', { programId: program.id });
        setWatched(true);
      }
    } catch {
      // The star is not the point of this page, but a star that silently did nothing would let a
      // user believe they will be told when this deadline moves.
      setWatchError('That could not be saved, so you are not watching this program yet.');
    }
  }

  return (
    <>
      <p className="eyebrow">{funder.name}</p>
      <div className="detail-head">
        <h1>{program.name}</h1>
        <StatusPill status={program.trust.status} />
        <VerdictBadge verdict={verdict} />
        <TrustBadge lastVerifiedAt={program.trust.lastVerifiedAt} now={nowISO} />
      </div>

      <p className="detail-lead">{program.summary}</p>

      {program.trust.staleMirrorWarning !== undefined && (
        <p className="stale-mirror">{program.trust.staleMirrorWarning}</p>
      )}

      {/* A URL the pipeline stored is not automatically a URL this page will offer. 345 ARDC
          records once advertised a grant recipient's Facebook page as the place to apply, and
          farweb.org now redirects to a gambling site. */}
      {applyUrl !== '' && applyBlocked !== null && <SourceLink href={applyUrl} />}

      <div className="detail-actions">
        {applyUrl !== '' && applyBlocked === null && (
          <a className="btn btn-primary" href={applyUrl} target="_blank" rel="noopener noreferrer">
            Apply at the funder
          </a>
        )}
        <button
          type="button"
          className="btn"
          onClick={() => {
            void toggleWatch();
          }}
        >
          {isWatched ? 'Stop watching this program' : 'Watch this program'}
        </button>
        <VerifyButton programId={program.id} onVerified={reload} />
      </div>

      {watchError !== null && (
        <p role="alert" className="error-text">
          {watchError}
        </p>
      )}

      {program.trust.disputed !== undefined && <DisputedPanel disputed={program.trust.disputed} />}

      <div className="detail-grid">
        <div>
          <section className="panel card" aria-label="Deadline">
            <h2>Deadline</h2>
            <dl>
              <dt>Pattern</dt>
              <dd className="data">{program.deadline.kind}</dd>
              <dt>Note</dt>
              <dd>{orNotStated(program.deadline.note)}</dd>
              {deadlineOwner !== null && (
                <>
                  <dt>Inherited</dt>
                  <dd>
                    This program inherits its deadline from{' '}
                    <Link to={`/o/${deadlineOwner.programId}`}>{deadlineOwner.programName}</Link>.
                    111 entries in the ARRL scholarship catalog share one close date, so the owning
                    program is where that date actually lives — and where to check it.
                  </dd>
                </>
              )}
            </dl>

            {cycles.length === 0 ? (
              <p className="unstated">
                No dated window resolves for this program inside the search horizon.
              </p>
            ) : (
              <ul className="cycle-list">
                {cycles.map((cycle) => (
                  <li key={cycle.id}>
                    {cycle.opensAt !== undefined && (
                      <>
                        <span className="data">{formatDate(cycle.opensAt, cycle.timezone)}</span>
                        {' to '}
                      </>
                    )}
                    <span className="data">{formatDate(cycle.closesAt, cycle.timezone)}</span>{' '}
                    {cycle.label}{' '}
                    {/* Only 4 of the corpus's 243 cycles are windows a funder actually published.
                        A projection printed without that word is a date the reader will plan
                        around as if someone had promised it. */}
                    <span className={cycle.isEstimated ? 'cycle-projected' : 'cycle-published'}>
                      {cycle.isEstimated
                        ? 'Projected, not observed'
                        : 'Published by the funder'}
                    </span>
                    <br />
                    <span className="cycle-zone">
                      Dates shown in {cycle.timezone}, the zone the funder published them in.
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Task 18's drawer, not a second one: it quotes each constraint's `rawText` verbatim
              and deliberately does NOT invite the reader to "fill something in" to clear a
              correct exclusion. An ineligible verdict shown with no reasons is the silence this
              product exists to break. */}
          {verdict?.kind === 'ineligible' && (
            <IneligibilityDrawer programName={program.name} reasons={verdict.reasons} />
          )}

          {/*
            THE OTHER HALF OF THE SAME RULE, ADDED BY TASK 24'S ACCESSIBILITY PASS.

            An `unknown` verdict rendered here was a badge and nothing else. The badge's "this is
            a question, not a no" framing lived only in its `title`, which is an accessible
            DESCRIPTION rather than a name: several screen readers never read it, a touch user
            cannot hover it, and a keyboard user cannot reach it. Browse gets away with the badge
            alone because its census paragraph says the sentence in real text above the table —
            this page had no such sentence anywhere, so the one surface where a reader studies a
            single programme was the surface that explained the state least.

            The wording is `UnknownFields`' and `VerdictBadge`'s, deliberately: "waiting on", and
            never "fill this in and you get an answer". The matcher short-circuits per axis, so
            answering one field moves a verdict from one `unknown` to a DIFFERENT unknown as often
            as it settles anything.
          */}
          {verdict?.kind === 'unknown' && (
            <section className="panel card" aria-labelledby="unknown-verdict-heading">
              <h2 id="unknown-verdict-heading">Why this verdict is unknown</h2>
              <p>
                Unknown is not a &ldquo;no&rdquo;. Something this program asks for could not be
                answered from your profile, so the matcher stopped rather than ruling you out — an
                unset field yields unknown, never ineligible.
              </p>
              {verdict.missingProfileFields.length > 0 && (
                <ul>
                  {verdict.missingProfileFields.map((field) => (
                    <li key={field}>
                      {/* No `kind` argument: the detail response does not say which profile the
                          verdict was computed against, and guessing would send an organisation to
                          the student editor. Four keys exist on both, and the copy is identical
                          across them, so the kind-blind lookup is safe. */}
                      <Link to={profileFieldHref(field)}>{profileFieldLabel(field)}</Link>
                      {profileFieldHelp(field) !== '' && (
                        <span className="unstated"> {profileFieldHelp(field)}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <p>
                This program stops at the first thing it cannot work out about you, so answering
                one of these may reveal the next question rather than a final verdict.
              </p>
            </section>
          )}

          {program.fundingRestrictions.length > 0 && (
            <section className="panel card" aria-label="Funding restrictions">
              <h2>Funding restrictions</h2>
              <ul>
                {program.fundingRestrictions.map((restriction) => (
                  <li key={restriction}>{restriction}</li>
                ))}
              </ul>
            </section>
          )}

          <section className="panel card" aria-label="Obligations if you win">
            <h2>Obligations if you win</h2>
            <dl>
              {program.obligations.licenseObligation !== undefined && (
                <>
                  <dt>Licensing</dt>
                  <dd>{program.obligations.licenseObligation}</dd>
                </>
              )}
              {program.obligations.indirectCostCapPct !== undefined && (
                <>
                  <dt>Indirect cost cap</dt>
                  <dd className="data">{program.obligations.indirectCostCapPct}%</dd>
                </>
              )}
              <dt>Cost share</dt>
              <dd className={obligationState(program.obligations.costShareRequired) === 'unstated' ? 'unstated' : undefined}>
                {costShareCopy(obligationState(program.obligations.costShareRequired))}
              </dd>
              <dt>Co-funding</dt>
              <dd className={obligationState(program.obligations.coFunderPreference) === 'unstated' ? 'unstated' : undefined}>
                {coFunderCopy(obligationState(program.obligations.coFunderPreference))}
              </dd>
              {program.obligations.sustainmentObligation !== undefined && (
                <>
                  <dt>Sustainment</dt>
                  <dd>{program.obligations.sustainmentObligation}</dd>
                </>
              )}
              {program.obligations.reportingObligation !== undefined && (
                <>
                  <dt>Reporting</dt>
                  <dd>{program.obligations.reportingObligation}</dd>
                </>
              )}
            </dl>
          </section>

          {program.rawOtherText !== '' && (
            <section className="panel card" aria-label="Unstructured requirements, verbatim">
              <h2>Unstructured requirements, verbatim</h2>
              <p>
                Text from the source that no field on this page models. It is reproduced exactly,
                because paraphrasing is where a requirement that was never written down gets
                invented.
              </p>
              <p className="verbatim">{program.rawOtherText}</p>
            </section>
          )}

          <section className="panel card" aria-label="Field provenance">
            <h2>Where each value came from</h2>
            <ProvenanceTable rows={provenance} />
          </section>
        </div>

        <div>
          <section className="panel card" aria-label="Award">
            <h2>Award</h2>
            <dl>
              <dt>Instrument</dt>
              <dd className="data">{program.amount.instrument}</dd>
              <dt>Amount, verbatim</dt>
              <dd className="data">{orNotStated(program.amount.amountRaw)}</dd>
              <dt>Number of awards</dt>
              <dd className="data">{orNotStated(program.amount.awardCountRaw)}</dd>
            </dl>
          </section>

          {/*
            Plan 4 adds `Copy AI Prompt — includes AI-detection avoidance` beside this block.
            Plan 3 renders the quote and its URL and NOTHING else: a button whose copy no plan has
            reviewed is not a thing to ship early next to a policy quote.
          */}
          <section className="panel card" aria-label="AI policy">
            <h2>This funder&rsquo;s AI policy</h2>
            <p className="eyebrow">Stance: {program.aiPolicy.stance}</p>
            {program.aiPolicy.quote !== undefined && (
              <p className="verbatim">{program.aiPolicy.quote}</p>
            )}
            {program.aiPolicy.url !== undefined && (
              <p>
                <SourceLink href={program.aiPolicy.url} />
              </p>
            )}
            {program.aiPolicy.quote === undefined && (
              <p>
                This funder has not published a policy on applicants using AI. That is not
                permission and not a prohibition — you remain accountable for every claim you
                make.
              </p>
            )}
          </section>

          <section className="panel card" aria-label="Source">
            <h2>Source</h2>
            <dl>
              <dt>Page</dt>
              <dd>
                <SourceLink href={program.trust.sourceUrl} />
              </dd>
              <dt>Method</dt>
              <dd className="data">{program.trust.verificationMethod}</dd>
              <dt>Content hash</dt>
              <dd className="data">{program.trust.contentHash.slice(0, 16)}…</dd>
            </dl>
          </section>
        </div>
      </div>
    </>
  );
}
