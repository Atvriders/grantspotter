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
import { PrintButton } from '../components/PrintButton.js';
import { linkRefusal, type LinkRefusal } from '../lib/safety.js';
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
 * The tri-state for an obligation whose value is PROSE or a NUMBER rather than a flag.
 *
 * Read through core's `obligationState` — the same reader the two boolean obligations use —
 * rather than a bare `value !== undefined` test at each call site, because the bare test is what
 * `licenseObligation`, `indirectCostCapPct`, `sustainmentObligation` and `reportingObligation`
 * each had: `{program.obligations.X !== undefined && (…)}`, which emits NO ROW when the funder
 * said nothing. Four silent rows in the same `<dl>` as two that say "Not stated" is worse than
 * either alone — the reader takes the missing Reporting row for "no reporting obligation", which
 * is absence of evidence rendered as evidence of absence, the exact inversion the CONTRACT §3
 * amendment was made to prevent, and against this file's own rule at `orNotStated`.
 *
 * A blank string is not a statement either: `''` used to satisfy `!== undefined` and render an
 * empty cell.
 */
function statedState(value: string | number | undefined): ObligationState {
  const stated =
    typeof value === 'number' ? Number.isFinite(value) : value !== undefined && value.trim() !== '';
  return obligationState(stated ? true : undefined);
}

/**
 * What a prose or numeric obligation reads as, given its state and the funder's own words.
 *
 * The `switch` is over the same exhaustiveness-checked union as `costShareCopy`, so this cannot
 * quietly regrow an arm that renders nothing. `'no'` is unreachable for these four — a prose field
 * carries a sentence or carries nothing; there is no way to record "the funder said there is
 * none" — and is therefore routed to the unstated copy, which is the safe reading of a state that
 * should never arrive. If a negative claim ever becomes recordable it needs its own words, and
 * this is where the compiler will send whoever adds it.
 */
function statedCopy(state: ObligationState, value: string, unstated: string): string {
  switch (state) {
    case 'yes':
      return value;
    case 'no':
    case 'unstated':
      return unstated;
  }
}

const LICENSE_UNSTATED =
  'Not stated. No page this pipeline has fetched says whether holding or keeping a licence is a ' +
  'condition of this award, so ask the funder rather than reading this as "no licence needed".';

const INDIRECT_UNSTATED =
  'Not stated. No page this pipeline has fetched gives an indirect-cost cap. That is not a cap ' +
  'of zero and not an absence of one — it is a number to ask the funder for before you budget.';

const SUSTAINMENT_UNSTATED =
  'Not stated. No page this pipeline has fetched says whether you must keep the funded work ' +
  'running after the money is spent.';

const REPORTING_UNSTATED =
  'Not stated. No page this pipeline has fetched says what reporting this award carries. Ask ' +
  'before you assume there is none — reporting is what makes a small grant expensive.';

/**
 * What can honestly be said about the zone a cycle's dates are rendered in.
 *
 * The old sentence read "Dates shown in {zone}, the zone the funder published them in." Core
 * refuses that claim in terms: `observedCycles` hard-codes `timezone: 'UTC'` and its own
 * doc-comment says *"`timezone: 'UTC'` is that frame, not a claim about where the funder is"*. So
 * on every funder-published cycle — the exact rows the whole published/projected distinction
 * exists for — the page stated the opposite of what the data layer knows. A zone that IS recorded
 * is not a funder's claim either: it is what this pipeline wrote down with the recurrence rule.
 *
 * Two arms, and neither says "the funder". `'UTC'` is read as UNRECORDED because a rendered
 * `'UTC'` and a defaulted `'UTC'` are indistinguishable here, and the safe reading of an
 * ambiguity is the one that claims less. Measured over the FIXTURE corpus
 * (`scripts/profile-corpus.ts`, 150 publishable records at its fixed 2026-08-02 clock): 250
 * cycles resolve, 4 carry `UTC` (all four funder-published), 246 carry a recorded zone. That is a
 * different population from the `data/seed/` corpus a fresh install gets, and the arms below hold
 * on both because neither of them counts anything.
 *
 * `AgendaList`'s `zoneLabel` and `ProgramTable`'s `UTC` mark already held this line; this page
 * was the only deadline surface without it.
 */
function zoneSentence(timezone: string | null | undefined): string {
  const zone = (timezone ?? '').trim();
  if (zone === '' || zone.toUpperCase() === 'UTC') {
    return (
      'Dates shown in UTC — no zone is recorded for this cycle. UTC is the frame this product ' +
      'renders in, not a claim about the funder’s own day, which may fall either side of it.'
    );
  }
  return (
    `Dates shown in ${zone} — the zone recorded for this cycle, which is this pipeline’s ` +
    'reading of the deadline rule rather than something the funder printed.'
  );
}

/**
 * What to say about an apply URL this product will not turn into a link, in the reason's own
 * words rather than the blocklist's.
 *
 * A blocked host is `SourceLink`'s job and keeps its wording (farweb.org's takeover is a specific
 * warning, and the commercial aggregators are a licence matter, not a danger). The other two
 * reasons are new — see `lib/safety.ts` — and must not borrow the blocklist's sentence, which
 * would tell a reader that `javascript:alert(1)` is a host whose terms prohibit republishing.
 */
function refusedUrlSentence(refusal: Exclude<LinkRefusal, { kind: 'blocked_host' }>): string {
  switch (refusal.kind) {
    case 'unsupported_scheme':
      return (
        `This record's apply address uses the ${refusal.scheme} scheme. This product links only ` +
        'to absolute http and https addresses, so it is shown here as text and not as a link. ' +
        'Treat it as a broken record rather than as somewhere to go.'
      );
    case 'unreadable':
      return (
        'This record’s apply address is not an absolute http or https URL, so this product ' +
        'cannot tell where it points and will not link it. It is shown here as text.'
      );
  }
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
  const applyRefusal = linkRefusal(applyUrl);

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
      {applyUrl !== '' && applyRefusal?.kind === 'blocked_host' && <SourceLink href={applyUrl} />}

      {/* The other two refusals, in their own words. A `javascript:` or protocol-relative address
          is a broken record, not a hijacked host, and saying so with the blocklist's sentence
          would be a second false claim laid over the first. */}
      {applyUrl !== '' && applyRefusal !== null && applyRefusal.kind !== 'blocked_host' && (
        <p className="blocked-host" role="alert">
          {refusedUrlSentence(applyRefusal)} <span className="host">{applyUrl}</span>
        </p>
      )}

      <div className="detail-actions">
        {applyUrl !== '' && applyRefusal === null && (
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
        {/*
          The one path from finding an opportunity to writing for it. Without it a user who has
          found a program has no route into a draft for it at all.

          All three parameters are load-bearing. `selectTemplates` picks the overlay whose
          frontmatter `programIds` contains `programId` (for `ardc-grants`, `funder-ardc`) or whose
          `funderId` matches, and narrows the components on `klass`. A `programId` that differs
          from the overlay's by one character produces no error and no warning — just an empty
          "Funder overlays" group — which is why the ids in the seed corpus are the ones the
          overlays name, and never the other way round.
        */}
        <Link
          className="btn"
          to={`/applications?programId=${encodeURIComponent(program.id)}&klass=${encodeURIComponent(program.klass)}&funderId=${encodeURIComponent(program.funderId)}`}
        >
          Start an application for this program
        </Link>
        <VerifyButton programId={program.id} onVerified={reload} />
        <PrintButton label="Print brief" className="btn" />
      </div>

      {watchError !== null && (
        <p role="alert" className="error-text">
          {watchError}
        </p>
      )}

      {program.trust.disputed !== undefined && <DisputedPanel disputed={program.trust.disputed} />}

      <article className="opportunity-brief">
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
                    {/*
                      Was "111 entries in the ARRL scholarship catalog share one close date". The
                      figure is currently correct, which is exactly what made it worth removing: a
                      census typed into rendered copy is true until the corpus moves and then
                      silently is not, and nothing recounts it. What a reader needs is that the date
                      lives somewhere else, not how many records agree.
                    */}
                    Every entry in the ARRL scholarship catalog shares one close date, so the owning
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
                    {/* Nearly every window here is a projection: on `data/seed/`, the corpus a
                        fresh install gets, 3 of the 143 records declare a window their funder
                        published, and only 2 of those still resolve to a future cycle on
                        2026-08-04 (0 from 2026-10-01, once ARISS and Yaesu close). A projection
                        printed without that word is a date the reader will plan around as if
                        someone had promised it. No literal total is quoted because the total
                        moves with the wall clock — see `test/cycleCountCopy.test.ts`. */}
                    <span className={cycle.isEstimated ? 'cycle-projected' : 'cycle-published'}>
                      {cycle.isEstimated
                        ? 'Projected, not observed'
                        : 'Published by the funder'}
                    </span>
                    <br />
                    <span className="cycle-zone">{zoneSentence(cycle.timezone)}</span>
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
              {verdict.missingProfileFields.length > 0 ? (
                <p>
                  This program stops at the first thing it cannot work out about you, so answering
                  one of these may reveal the next question rather than a final verdict.
                </p>
              ) : (
                /*
                  AN UNKNOWN WITH NOTHING TO FILL IN — reachable since the matcher stopped
                  upgrading an unresolvable axis to `eligible` (close-out review I6). It happens
                  when a constraint is scoped to something no field on your profile can answer:
                  an organisation against a county or call-district geography, for instance, where
                  the org editor has no such input to send you to. Naming a field here would be a
                  promise the product cannot keep, and saying nothing would leave a bare badge —
                  so the honest answer is to say there is nothing to answer.
                */
                <p>
                  Nothing you can enter here would settle this one. Something this program asks
                  for is not a question any field on your profile puts to you, so the matcher
                  stopped rather than guess. It is still not a &ldquo;no&rdquo; — read the
                  funder&rsquo;s own page and decide for yourself.
                </p>
              )}
            </section>
          )}

          {/*
            CLOSE-OUT REVIEW RESIDUAL — I4's second paragraph, left undone alongside the six
            obligations. An empty array made this whole section vanish on 147 of the 150
            publishable records: no heading, nothing. That silence reads as "there are none",
            which is an assertion the data does not make — a program with no funding restrictions
            ON RECORD is not the same claim as a funder stating in writing that none apply, and
            the same inversion that had 597 obligation rows render as nothing (I4, above).

            The section now ALWAYS renders, and says so in words when the list is empty, the same
            choice I4 made for `licenseObligation`, `indirectCostCapPct`, `sustainmentObligation`
            and `reportingObligation`: never let an absent row stand in for "not required".
          */}
          <section className="panel card" aria-label="Funding restrictions">
            <h2>Funding restrictions</h2>
            {program.fundingRestrictions.length > 0 ? (
              <ul>
                {program.fundingRestrictions.map((restriction) => (
                  <li key={restriction}>{restriction}</li>
                ))}
              </ul>
            ) : (
              <p className="unstated">
                No funding restrictions are recorded for this program. That is not the same as the
                funder saying none apply — ask before assuming there is no restriction on how the
                award may be used.
              </p>
            )}
          </section>

          {/*
            ALL SIX ROWS, ALWAYS. Four of these used to be wrapped in
            `{value !== undefined && (…)}`, so an obligation the funder never mentioned emitted no
            row at all — beside two rows that correctly said "Not stated". Over the 150 publishable
            records that was 597 silent rows: `sustainmentObligation` unstated on 150,
            `licenseObligation` on 149, `indirectCostCapPct` on 149, `reportingObligation` on 149.
            Every one of the 150 records had at least one.

            All six are read through core's `obligationState` so they cannot drift apart again.
          */}
          <section className="panel card" aria-label="Obligations if you win">
            <h2>Obligations if you win</h2>
            <dl>
              <dt>Licensing</dt>
              <dd
                className={
                  statedState(program.obligations.licenseObligation) === 'unstated'
                    ? 'unstated'
                    : undefined
                }
              >
                {statedCopy(
                  statedState(program.obligations.licenseObligation),
                  program.obligations.licenseObligation ?? '',
                  LICENSE_UNSTATED,
                )}
              </dd>
              <dt>Indirect cost cap</dt>
              <dd
                className={
                  statedState(program.obligations.indirectCostCapPct) === 'unstated'
                    ? 'unstated'
                    : 'data'
                }
              >
                {statedCopy(
                  statedState(program.obligations.indirectCostCapPct),
                  `${String(program.obligations.indirectCostCapPct ?? '')}%`,
                  INDIRECT_UNSTATED,
                )}
              </dd>
              <dt>Cost share</dt>
              <dd className={obligationState(program.obligations.costShareRequired) === 'unstated' ? 'unstated' : undefined}>
                {costShareCopy(obligationState(program.obligations.costShareRequired))}
              </dd>
              <dt>Co-funding</dt>
              <dd className={obligationState(program.obligations.coFunderPreference) === 'unstated' ? 'unstated' : undefined}>
                {coFunderCopy(obligationState(program.obligations.coFunderPreference))}
              </dd>
              <dt>Sustainment</dt>
              <dd
                className={
                  statedState(program.obligations.sustainmentObligation) === 'unstated'
                    ? 'unstated'
                    : undefined
                }
              >
                {statedCopy(
                  statedState(program.obligations.sustainmentObligation),
                  program.obligations.sustainmentObligation ?? '',
                  SUSTAINMENT_UNSTATED,
                )}
              </dd>
              <dt>Reporting</dt>
              <dd
                className={
                  statedState(program.obligations.reportingObligation) === 'unstated'
                    ? 'unstated'
                    : undefined
                }
              >
                {statedCopy(
                  statedState(program.obligations.reportingObligation),
                  program.obligations.reportingObligation ?? '',
                  REPORTING_UNSTATED,
                )}
              </dd>
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
      </article>
    </>
  );
}
