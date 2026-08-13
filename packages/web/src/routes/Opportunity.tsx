import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Constraint, Cycle, Funder, ObligationState, Program, Verdict } from '@grantspotter/core';
import { hasFunderWording, obligationState } from '@grantspotter/core';
import { useApi } from '../store/useApi.js';
import { apiSend } from '../api/client.js';
import { VerdictBadge, unrepresentedRoutesOf } from '../components/VerdictBadge.js';
import { TrustBadge } from '../components/TrustBadge.js';
import { StatusPill } from '../components/StatusPill.js';
import { DisputedPanel } from '../components/DisputedPanel.js';
import { IneligibilityDrawer, reasonHeading } from '../components/IneligibilityDrawer.js';
import { ProvenanceTable, type FieldProvenance } from '../components/ProvenanceTable.js';
import { SourceLink } from '../components/SourceLink.js';
import { VerifyButton } from '../components/VerifyButton.js';
import { PrintButton } from '../components/PrintButton.js';
import { linkRefusal, type LinkRefusal } from '../lib/safety.js';
import { profileFieldHelp, profileFieldHref, profileFieldLabel } from '../lib/profileFields.js';
import { formatDate } from '../lib/trust.js';
/*
  THE TRANSLATION TABLES THIS SCREEN OWNED AND DID NOT USE.

  `INSTRUMENT_LABELS` is Browse's facet list — the same enum, rendered as "Cash range", one click
  away from this page, since Plan 3. It is imported rather than restated: a second copy is how the
  facet list and the record page come to disagree about what `cash_tiered_blocks` is called, and
  `lib/filterState.ts` is already the file that fails to compile when a new `Instrument` arrives.
  (`web -> core` and web-to-web only; nothing here reaches into `server`.)
*/
import { INSTRUMENT_LABELS } from '../lib/filterState.js';
import {
  AI_STANCE_WORDS,
  DEADLINE_KIND_WORDS,
  VERIFICATION_METHOD_WORDS,
  readDeadlineNote,
} from '../lib/programWords.js';
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
 * ONE REQUIREMENT, AS THE FUNDER WROTE IT. Nothing here is a claim about the reader.
 *
 * The quote block is entered ONLY through `hasFunderWording`, the same gate `IneligibilityDrawer`
 * and `ProgramTable` use: `.verbatim` means "a funder published this sentence", and an empty
 * monospaced box under a heading is the same fabrication as filling one in. No constraint in the
 * shipped corpus is in that state — measured over the 150 publishable records, all 522 hard and all
 * 127 soft constraints carry funder wording — which is exactly why the branch is written now rather
 * than when the first one arrives.
 *
 * No structured restatement (`tierDetail`) accompanies the quote, deliberately. That line exists in
 * the drawer to say WHY a rule refused; here nothing refused, and a software-composed paraphrase
 * beside every requirement would be both the wall of text this panel must not become and a second
 * voice on a list whose whole value is that it is the funder's.
 */
function RequirementQuote({ constraint }: { constraint: Constraint }): JSX.Element {
  return (
    <li>
      <span className="eyebrow">{reasonHeading(constraint)}</span>
      {hasFunderWording(constraint) ? (
        <p className="verbatim">{constraint.rawText}</p>
      ) : (
        <span className="authored">
          <span className="authored-by">GrantSpotter&rsquo;s words, not the funder&rsquo;s</span>
          No funder sentence was recorded for this one. Open this record&rsquo;s source page and
          read it there before you rely on it.
        </span>
      )}
    </li>
  );
}

/**
 * WHAT AN `eligible` VERDICT OWES THE PERSON IT SAYS YES TO.
 *
 * An `ineligible` verdict gets a whole drawer quoting the funder on every constraint that refused;
 * an `unknown` gets a panel naming what is missing and whose gap it is. An `eligible` verdict got a
 * badge. THIS PAGE READ `program.constraints` IN EXACTLY TWO PLACES — the `orUnrepresented` panel
 * and the drawer — and both are reachable only from a verdict that is not `eligible`, so a reader
 * told yes saw no funder requirement sentence anywhere on the page. The full hard-constraint list
 * existed only in `requirementsChecklistMarkdown`, inside the application-packet ZIP, which is
 * downloaded AFTER the decision to apply has been made. The reader with the most at stake — an
 * application fee, transcript fees, three recommendation letters — had the least on screen.
 *
 * IT IS ALSO WHERE THE REPO'S STANDING MITIGATION HAD TO BE MADE TRUE. `matcher.ts` justifies
 * passing a constraint it cannot fully represent on the grounds that the applicant "open[s] the
 * funder's page, whose verbatim text this app always renders, and find[s] out". For an eligible
 * verdict the app rendered no such text: `rawOtherText` carries some of it on some records (15 of
 * the 26 records in the class this round is closing) and nothing on the rest. This panel is what
 * makes that sentence true rather than aspirational.
 *
 * THE LIST MAKES NO CLAIM ABOUT THE READER AT ALL. Every row is a sentence the funder published,
 * quoted; the one thing the software asserts — that nothing here refused this profile — is a single
 * marked line at the top wearing "GrantSpotter's words, not the funder's". That division is what
 * keeps the panel honest for the 26 records where a hard constraint the profile does NOT satisfy
 * was passed leniently: the reader is not told they meet each line, they are told what the lines
 * are and that the software only checks the part of each it can represent.
 *
 * SIZE, MEASURED, because "a student eligible for 43 programmes should not have to read 43
 * checklists". This panel renders on ONE programme's record page and never in `ProgramTable`, where
 * that reader actually is. Over the 150 publishable records at `scripts/profile-corpus.ts`'s fixed
 * 2026-08-02 clock, the licensed EE undergraduate's 43 `eligible` + 9 `eligible_preferred` records
 * carry a MEDIAN of 4 hard constraints (max 7) whose `rawText` runs 38 characters at the median.
 * The requirement half of the panel is 115 characters of quotation at the median, 564 at the 90th
 * percentile and 1,140 at its worst. Four short quotations is the typical panel, not a wall.
 *
 * THE PREFERENCES ARE THE EXPENSIVE HALF, AND THEY ARE KEPT ANYWAY. Of those 51 records 30 carry a
 * preference and 23 carry one on the `other` axis, which is the extractor's catch-all: on 13 of the
 * 51 that catch-all constraint's `rawText` CONTAINS another constraint's sentence whole, so the
 * preference list reprints lines the requirement list quoted a few rows above. Whole-panel
 * quotation goes from a 115-character median to 236, and from 1,140 at worst to 1,937. That
 * duplication is a record-quality artifact in `normalize/`, not something to paper over here by
 * dropping the section: a preference is what an `eligible_preferred` badge is about, and the only
 * other place on this product that quotes one is the requirements checklist inside the application
 * packet — which is downloaded after the reader has already decided to apply, the exact failure
 * this panel exists to close. Suppressing a funder's sentence because another field repeats it
 * would be the view lying about the record to flatter itself.
 *
 * BUCKETED BY THE RECORD'S OWN `hard` FLAG, not by how the matcher treats it. `matchProgram` forces
 * `financial_need` soft whatever the record says (spec §4.5 rule 11), and moving a funder's stated
 * requirement under a heading that reads "these never exclude you" would be this software
 * overruling the funder's sentence in the one place built to reproduce it.
 */
function RequirementsPanel({ program }: { program: Program }): JSX.Element {
  const requirements = program.constraints.filter((constraint) => constraint.hard);
  const preferences = [...program.constraints.filter((constraint) => !constraint.hard)].sort(
    (a, b) => a.fallbackRank - b.fallbackRank || a.id.localeCompare(b.id),
  );

  return (
    <section className="panel card" aria-labelledby="requirements-heading">
      <h2 id="requirements-heading">What this program requires</h2>
      <p className="authored">
        <span className="authored-by">GrantSpotter&rsquo;s words, not the funder&rsquo;s</span>
        {requirements.length === 0
          ? /*
              AN ELIGIBLE VERDICT OVER AN EMPTY LIST IS A VERDICT ABOUT NOTHING, and saying "you
              meet every requirement" about a record that states none is the vacuous truth
              `matcher.ts` withdrew for a record with NO constraints at all. A record that carries
              preferences but no requirement still reaches here, so the panel says plainly that the
              yes above rests on an empty list — and, per this file's standing rule, that an absent
              requirement is not a funder stating there are none.
            */
            'No requirement is recorded for this program, so nothing was checked against you — the verdict above rests on an empty list rather than on a funder saying yes. That is not the funder stating there are none. Read their own page before you spend an application fee.'
          : 'Nothing recorded here refused your profile. That is weaker than a funder saying yes: GrantSpotter checks only the part of each sentence below that it can represent, and the funder holds you to all of it. Read them before you spend an application fee.'}
      </p>

      {requirements.length > 0 && (
        <ul className="requirement-list">
          {requirements.map((constraint) => (
            <RequirementQuote key={constraint.id} constraint={constraint} />
          ))}
        </ul>
      )}

      {preferences.length > 0 && (
        <>
          <h3 className="requirement-subhead">Preferences</h3>
          {/* Not marked as GrantSpotter's, because it is a section label rather than a sentence
              standing where a quotation would: the quotes are in their own blocks underneath.
              The claim is the matcher's own — only `hard` constraints can reach `hardFailures`,
              and a soft one can never produce a refusal. */}
          <p className="unstated">
            These rank you. A preference you do not match cannot make you ineligible, and one you do
            match is a tie-breaker the funder applies at their discretion.
          </p>
          <ul className="requirement-list">
            {preferences.map((constraint) => (
              <RequirementQuote key={constraint.id} constraint={constraint} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
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
  /*
    Constraints whose spec carries `orUnrepresented` — a route this record names and this schema
    cannot describe. Kept as the CONSTRAINTS, not just the route strings, because each one owns the
    funder's own sentence, and the whole point of naming the obstacle is that the reader can then
    read the sentence it came out of and judge it themselves.
  */
  const unrepresented = program.constraints.filter(
    (constraint) => constraint.spec.orUnrepresented !== undefined,
  );
  const deadlineNote = readDeadlineNote(program.deadline.note);

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
        <VerdictBadge verdict={verdict} unrepresentedRoutes={unrepresentedRoutesOf(program)} />
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
              {/* Was `{program.deadline.kind}` in `.data`, the monospaced class this app reserves
                  for figures a reader copies — so `n_fixed_dates` was not merely raw, it was
                  presented as a value. `DEADLINE_KIND_WORDS` is the same table the calendar's
                  undated list reads, now typed against `DeadlineKind` so a new kind cannot reach
                  a reader as an identifier. */}
              <dd>{DEADLINE_KIND_WORDS[program.deadline.kind]}</dd>
              {deadlineNote.rule !== undefined && (
                <>
                  <dt>Repeats</dt>
                  <dd>{deadlineNote.rule}</dd>
                </>
              )}
              <dt>Note</dt>
              {/*
                The FUNDER-FACING half of `deadline.note`, never the `RECUR …` directive in front of
                it. On the six publishable records that carry a directive the note began
                `RECUR n_fixed_dates tz=America/Los_Angeles dates=02-01,04-01,07-01,09-01`, and a
                reader who cannot parse that has been shown a schedule they cannot read on the one
                screen where they decide whether to spend an application fee. The dates it encodes
                are not lost: they are the "Repeats" row above, in English, and only when the
                directive actually parsed.

                A note that is ONLY a directive leaves nothing behind, so it takes `NOT_STATED`
                rather than an empty cell — this file's standing rule, and true here: the funder
                wrote no note, GrantSpotter wrote a rule.
              */}
              <dd>{orNotStated(deadlineNote.prose)}</dd>
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

          {/*
            THE THIRD VERDICT PANEL, and the one that was missing. The three are mutually exclusive
            by verdict kind and sit in one place so no reader has to learn a different geography per
            verdict.

            Only `eligible` and `eligible_preferred`. An `ineligible` reader gets the drawer below,
            which quotes the constraints that refused them; adding every OTHER constraint underneath
            it would double the page for the one reader who has already been told no. A null verdict
            — no profile saved — is not shown one either: this panel's lede is a statement about a
            verdict, and there is no verdict to make it about.
          */}
          {(verdict?.kind === 'eligible' || verdict?.kind === 'eligible_preferred') && (
            <RequirementsPanel program={program} />
          )}

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
              {/*
                THE LEDE USED TO BE UNCONDITIONAL, AND ON ONE OF ITS TWO BRANCHES EVERY CLAUSE OF
                IT WAS FALSE.

                It read: "Something this program asks for could not be answered from your profile,
                so the matcher stopped rather than ruling you out — an unset field yields unknown,
                never ineligible." Where `missingProfileFields` is empty, nothing this program asks
                for is at issue — the commonest cause is a record that asks NOTHING, because nobody
                ever wrote down who may apply (19 of the 20 such records in the shipped corpus, and
                20 of a licensed EE undergraduate's 27 unknown verdicts) — the profile is not where
                the gap is, and no field was left unset. Two paragraphs later the same panel said
                "Nothing you can enter here would settle this one", so the page contradicted
                itself, and the two tests over this branch each read only the half that was true.

                `VerdictBadge` was corrected for the identical state in the same commit that
                created the 19. The badge and this panel are on screen together and may not
                disagree about whose gap it is.
              */}
              {verdict.missingProfileFields.length > 0 ? (
                <p>
                  Unknown is not a &ldquo;no&rdquo;. Something this program asks for could not be
                  answered from your profile, so the matcher stopped rather than ruling you out —
                  an unset field yields unknown, never ineligible.
                </p>
              ) : unrepresented.length > 0 ? (
                /*
                  THE LEDE HAS TO BE TRUE OF ITS OWN BRANCH TOO, and the unconditional one below
                  is not true of this one. "There is no field on your profile that would settle
                  it" holds for a record whose applicant list nobody filled in; it is FALSE on the
                  49 field-of-study records, where a different value in the applicant's own
                  `fieldOfStudy` box would settle it perfectly well — the reason nobody can decide
                  is that "is Music Performance inside Science, Math, Engineering or Technology?"
                  is not a question word overlap can answer. The panel and the badge sit on this
                  page together and may not disagree about whose limit this is.
                */
                <p>
                  Unknown is not a &ldquo;no&rdquo;. This funder named a way of qualifying that
                  GrantSpotter cannot check, so the matcher declined to decide rather than rule you
                  out. Nothing on your profile was left blank; the judging is the part no rule here
                  can do.
                </p>
              ) : (
                <p>
                  Unknown is not a &ldquo;no&rdquo;. Something the matcher needed could not be
                  worked out at all, so it stopped rather than ruling you out. It is not a gap in
                  what you have told us — there is no field on your profile that would settle it.
                </p>
              )}
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
              ) : unrepresented.length > 0 ? (
                /*
                  THE THIRD CAUSE OF AN UNKNOWN WITH NOTHING TO FILL IN, and the only one where
                  the obstacle is nameable and the reader can act on it.

                  `ConstraintAlternatives.orUnrepresented` holds a route the funder named that this
                  schema cannot describe — "and to previous awardees" is not a `Stage`, and whether
                  Music Performance falls inside "Science, Math, Engineering or Technology" is not
                  word overlap. The matcher declines to decide rather than refuse, which is right,
                  and until now the reason never reached a reader: the panel said "Nothing you can
                  enter here would settle this one" and left it there.

                  BOTH CLAUSES OF THAT SENTENCE ARE WRONG HERE, which is why this branch exists
                  rather than a paragraph appended to it. "Whatever the matcher could not work out
                  is not a question any field on your profile puts to you" is false of the 49
                  field-of-study records, where the applicant's own `fieldOfStudy` is exactly what
                  nobody can adjudicate; and pointing at a gap in GrantSpotter's record is false of
                  all 51, whose records are complete and whose funder's sentence is printed below.
                  Measured over the shipped corpus with `scripts/profile-corpus.ts`: 51 constraints
                  across 51 of the 150 publishable programmes, and for the graduate music student
                  20 of the unknowns with nothing to fill in are of this kind.

                  IT DOES NOT CLAIM TO BE THE CAUSE. `Verdict.unknown` carries only
                  `missingProfileFields`, and this page is never told which profile the verdict was
                  computed against, so nothing here can prove this route is what stopped THIS
                  verdict. The copy says what the record names and what that does to a verdict, and
                  stops there.
                */
                <>
                  <p className="authored">
                    <span className="authored-by">
                      GrantSpotter&rsquo;s words, not the funder&rsquo;s
                    </span>
                    This is not a gap in the funder&rsquo;s page and not a gap in your profile — it
                    is a route no rule here can test. Read their own sentence below and judge for
                    yourself whether it describes you.
                  </p>
                  <ul className="unrepresented-routes">
                    {unrepresented.map((constraint) => (
                      <li key={constraint.id}>
                        <span className="eyebrow">{reasonHeading(constraint)}</span>
                        <span className="authored">
                          <span className="authored-by">
                            GrantSpotter&rsquo;s words, not the funder&rsquo;s
                          </span>
                          The route GrantSpotter cannot check here:{' '}
                          {constraint.spec.orUnrepresented}
                        </span>
                        {/* The funder's own sentence, verbatim and quotable — `.verbatim` is this
                            page's box for text a funder published, and the line above is
                            deliberately outside it. */}
                        {hasFunderWording(constraint) && (
                          <p className="verbatim">{constraint.rawText}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                /*
                  AN UNKNOWN WITH NOTHING TO FILL IN — reachable since the matcher stopped
                  upgrading an unresolvable axis to `eligible` (close-out review I6). Naming a
                  field here would be a promise the product cannot keep, and saying nothing would
                  leave a bare badge — so the honest answer is to say there is nothing to answer.

                  THE CAUSE THIS COMMENT NAMED WAS NOT THE CAUSE. It said this happens "when a
                  constraint is scoped to something no field on your profile can answer: an
                  organisation against a county or call-district geography, for instance". Measured
                  over the shipped corpus at 2026-08-12, that case occurs ZERO times, and the two
                  that do occur are both holes in GrantSpotter's own record: 19 programmes whose
                  applicant list nobody ever filled in, and one radius rule whose stated centre
                  ("YCCC center which is in Erving, MA. MA") never resolved to a coordinate. The
                  copy below was written to the wrong cause, which is how it came to say "something
                  this program asks for" about records that ask for nothing at all.
                */
                <p>
                  Nothing you can enter here would settle this one. Whatever the matcher could not
                  work out is not a question any field on your profile puts to you, so it stopped
                  rather than guess. It is still not a &ldquo;no&rdquo; — read the funder&rsquo;s
                  own page and decide for yourself.
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
              {/* Browse's facet list has called this "Cash range" since Plan 3; this cell called it
                  `cash_range`, in the monospaced `.data` class, one click away. Same map, so the
                  two surfaces cannot drift. */}
              <dd>{INSTRUMENT_LABELS[program.amount.instrument]}</dd>
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
            {/*
              Was "Stance: {stance}", which printed `permitted_with_disclosure` verbatim and — on
              149 of the 150 publishable records — `unaddressed`, a token that reads as a position
              the funder took. It is the absence of one.
            */}
            <p>{AI_STANCE_WORDS[program.aiPolicy.stance]}</p>
            {program.aiPolicy.quote !== undefined && (
              <p className="verbatim">{program.aiPolicy.quote}</p>
            )}
            {program.aiPolicy.url !== undefined && (
              <p>
                <SourceLink href={program.aiPolicy.url} />
              </p>
            )}
            {/*
              KEYED ON THE STANCE, NOT ON WHETHER A QUOTE EXISTS, and that was a latent
              contradiction rather than a tidy-up.

              "This funder has not published a policy on applicants using AI" was printed whenever
              `quote` was absent — including for a record whose stance is `permitted`,
              `discouraged` or `prohibited` with no sentence recorded. The line above would then
              say the funder permits it and this one would say they have published nothing, on the
              same card, about the same funder. The shipped corpus does not produce that pair
              (measured: 1 record `permitted` with a quote, 149 `unaddressed` with none), which is
              exactly why it could sit here unnoticed — the schema makes `quote` optional on every
              stance, so nothing but this branch stops it.

              The second sentence is unchanged and still belongs only to `unaddressed`: silence is
              not permission and not a prohibition.
            */}
            {program.aiPolicy.stance === 'unaddressed' ? (
              <p>
                That is not permission and not a prohibition — you remain accountable for every
                claim you make.
              </p>
            ) : (
              program.aiPolicy.quote === undefined && (
                <p className="authored">
                  <span className="authored-by">
                    GrantSpotter&rsquo;s words, not the funder&rsquo;s
                  </span>
                  No sentence of the funder&rsquo;s was recorded for this position, so the line
                  above is this pipeline&rsquo;s reading rather than a quotation. Read their own
                  page before you rely on it.
                </p>
              )
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
              {/* `seed_import` and `live_fetch` are pipeline stages. What a reader needs from this
                  row is how much to trust it, which is what the words say. */}
              <dd>{VERIFICATION_METHOD_WORDS[program.trust.verificationMethod]}</dd>
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
