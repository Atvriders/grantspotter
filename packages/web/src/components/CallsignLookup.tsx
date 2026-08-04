import { useId, useState, type ReactNode } from 'react';
import type { LicenseClass } from '@grantspotter/core';
import { ApiError } from '../api/client.js';
import {
  postCallsignLookup,
  type CallsignLookupResult,
  type CallsignRecord,
} from '../api/callsign.js';
import { formatDate } from '../lib/trust.js';
import './callsign.css';

/**
 * "LOOK UP MY CALLSIGN", AND THE RECORD IT PUTS ON SCREEN.
 *
 * One control, used beside the callsign field on the profile editor and on the first-run
 * setup screen. It is the only place in this product where a value about the USER arrives
 * from somewhere other than the user, so the rules it keeps are the whole point of it:
 *
 *  1. NOTHING IS FILLED IN UNTIL THE PERSON SAYS SO. The panel shows what was found and
 *     waits. There is no auto-fill on success.
 *  2. WHAT IT FILLS IN LOOKS FILLED IN. The values leave here with their provenance
 *     attached, and the host form marks every field that came from here until the person
 *     edits it themselves.
 *  3. IT SHOWS THE ADDRESS AND STORES NONE OF IT. The street is how a person recognises
 *     their own record; it is not persisted, there is no column for it, and nothing reads
 *     it. Only the state leaves this panel, because eligibility rules use the state.
 *  4. IT NEVER GUESSES A LICENCE CLASS. An operator class that maps exactly onto core's
 *     four arrives mapped. Advanced, Novice and Technician Plus map onto none of them, so
 *     the select opens UNSET and says why. Guessing upward manufactures a false ELIGIBLE,
 *     which is the one mistake this product refuses to make.
 *  5. IT NEVER FILLS "LICENSED SINCE". The record's grant date resets on every renewal and
 *     every vanity change, so it is not the date the licence was first held — and
 *     `licensedSince` feeds `heldMonthsMin` in the matcher, where a wrong value becomes a
 *     confident, wrong eligibility verdict. The date is shown, labelled for what it is,
 *     and goes no further.
 */

/** Where a filled-in value came from, carried to the host so the field can say so. */
export interface CallsignProvenance {
  /**
   * The source's own name, as the record reports it. Typed as the record's literal rather than
   * as a string so a host can put it straight into core's `ProfileFieldSource`, whose `source`
   * is that same literal — a widened type here would need a cast there, and a cast is where a
   * second source would one day be mislabelled as this one.
   */
  source: CallsignRecord['source'];
  /** ISO instant the record was fetched. */
  fetchedAt: string;
  /** The FCC's own page for this record, so the user can check us. */
  ulsUrl?: string;
}

/**
 * What the user accepted. Only fields the profile actually stores appear here: there is no
 * street, no licensee name for a person, and no `licensedSince`.
 */
export interface AcceptedCallsign {
  callsign: string;
  /**
   * Whether the licence is a person's or a club station's. The host needs it because the two
   * belong on different profiles, and a collegiate club station — the shape this product's
   * primary audience holds — is a CLUB.
   */
  type: CallsignRecord['type'];
  state?: string;
  licenseClass?: LicenseClass;
  /** Club stations only, and only where the host has somewhere to put an organisation name. */
  orgName?: string;
  provenance: CallsignProvenance;
}

export type CallsignTarget = 'student' | 'organization';

export interface CallsignLookupProps {
  /** The callsign currently typed in the field this control sits beside. */
  callsign: string;
  /**
   * Which profile the accepted values would land on. It decides which fields this panel
   * offers: an organisation profile has no licence class, and a person has no orgName.
   */
  target: CallsignTarget;
  onAccept: (values: AcceptedCallsign) => void;
  /** First run only: the one-time setup token, which is the caller's only credential. */
  setupToken?: string;
  /**
   * What this host can and cannot do with a CLUB record. It differs per screen — the profile
   * editor has an organisation tab to send the user to, the setup screen does not — so the
   * host supplies the sentence rather than this component guessing at it.
   */
  clubNotice?: ReactNode;
}

const LICENSE_OPTIONS: { value: LicenseClass; label: string }[] = [
  { value: 'NONE', label: 'None — not licensed' },
  { value: 'TECH', label: 'Technician' },
  { value: 'GENERAL', label: 'General' },
  { value: 'EXTRA', label: 'Amateur Extra' },
];

const LICENSE_VALUES = new Set<string>(LICENSE_OPTIONS.map((option) => option.value));

function isLicenseClass(value: string): value is LicenseClass {
  return LICENSE_VALUES.has(value);
}

/**
 * The five statuses, as a runtime set. The type says a response can only be one of these; the
 * wire does not, and this app is served behind a tunnel where a proxy or a captive portal can
 * answer 200 with something else entirely (see `apiFetch`'s non-JSON guard, which is the same
 * defence one layer down). An unrecognised status must not reach `frameFor`, whose exhaustive
 * switch would hand back `undefined` and blank the screen.
 */
const KNOWN_STATUSES: ReadonlySet<string> = new Set([
  'found',
  'not_found',
  'not_us',
  'updating',
  'unavailable',
]);

type Phase =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'answered'; result: CallsignLookupResult }
  | { kind: 'accepted'; record: CallsignRecord }
  /** The request itself did not complete: no answer was received, so none is reported. */
  | { kind: 'failed'; message: string };

interface Frame {
  heading: string;
  body: string;
}

/**
 * The sentence for each status. FIVE STATUSES, FIVE ANSWERS — a shared "lookup failed" would
 * tell an international operator that something is wrong with their licence, and would tell
 * somebody whose source is mid-import that their callsign does not exist.
 *
 * The server's own `message` is rendered beneath whichever of these applies, unedited. This
 * copy is what the SCREEN promises; that message is what the SERVER observed, and flattening
 * one into the other loses the half the user needs.
 */
export function frameFor(status: CallsignLookupResult['status'], callsign: string): Frame {
  switch (status) {
    case 'found':
      return { heading: `FCC record for ${callsign}`, body: '' };
    case 'not_found':
      return {
        heading: `No active licence record for ${callsign}`,
        body:
          'callook.info publishes the FCC licence database and has no active record under this ' +
          'callsign. That is not a judgement about you: a callsign issued or changed in the last ' +
          'day or so may not have reached the daily import yet, and a typo lands here too. Check ' +
          'the spelling, or fill the form in yourself — nothing here is required.',
      };
    case 'not_us':
      return {
        heading: `${callsign} is not a US callsign, so there is nothing to look up`,
        body:
          'This is not an error and nothing is wrong with your licence. GrantSpotter reads the ' +
          'FCC database, which covers US licences only, so it holds no record of any other ' +
          'administration to check against. Fill the form in yourself; every other part of ' +
          'GrantSpotter works exactly the same way for you.',
      };
    case 'updating':
      return {
        heading: 'callook.info is re-importing the FCC database right now',
        body:
          'The source rebuilds itself from the FCC once a day and cannot answer while it does. ' +
          'This says nothing about your callsign — it is not missing, it is unreadable for a few ' +
          'minutes. Try again shortly, or fill the form in yourself.',
      };
    case 'unavailable':
      return {
        heading: 'The lookup did not get an answer',
        body:
          'GrantSpotter could not reach callook.info, so it is not telling you anything about ' +
          'this callsign either way. Nothing on this form was changed. Try again, or fill it in ' +
          'yourself.',
      };
  }
}

/** The record's own words for its operator class, or the truth about a club licence. */
function operatorClassText(record: CallsignRecord): string {
  if (record.operClassRaw !== undefined && record.operClassRaw !== '') return record.operClassRaw;
  return record.type === 'CLUB'
    ? 'None — a club station licence has no operator class'
    : 'Not stated in the record';
}

export function CallsignLookup({
  callsign,
  target,
  onAccept,
  setupToken,
  clubNotice,
}: CallsignLookupProps): JSX.Element {
  const baseId = useId();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  const typed = callsign.trim().toUpperCase();

  async function run(): Promise<void> {
    setPhase({ kind: 'busy' });
    try {
      const result = await postCallsignLookup({
        callsign: typed,
        ...(setupToken === undefined || setupToken === '' ? {} : { setupToken }),
      });
      setPhase(
        KNOWN_STATUSES.has(result.status)
          ? { kind: 'answered', result }
          : {
              kind: 'failed',
              message:
                'The API answered with something that is not a lookup result, so nothing is ' +
                'being reported about this callsign. Something other than GrantSpotter — a ' +
                'proxy, tunnel, or sign-in page — may have answered instead.',
            },
      );
    } catch (err) {
      // A refusal or an unreachable API is not an answer about the callsign, and must not be
      // reported as one. The server's sentence is carried through — for a rate limit that
      // sentence is the whole explanation.
      setPhase({
        kind: 'failed',
        message:
          err instanceof ApiError && err.status !== 0
            ? err.message
            : 'The GrantSpotter API could not be reached, so the lookup never ran.',
      });
    }
  }

  const answered = phase.kind === 'answered' ? phase.result : null;
  const record = answered?.status === 'found' ? (answered.record ?? null) : null;

  const announcement = ((): string => {
    switch (phase.kind) {
      case 'idle':
        return '';
      case 'busy':
        return `Looking up ${typed}…`;
      case 'accepted':
        return 'Filled in from the FCC record. Nothing has been saved yet.';
      case 'failed':
        return `The lookup did not run. ${phase.message}`;
      case 'answered': {
        const frame = frameFor(phase.result.status, typed);
        return phase.result.record === undefined
          ? frame.heading
          : `${frame.heading}: ${phase.result.record.name}. Nothing has been filled in yet.`;
      }
    }
  })();

  return (
    <div className="callsign-lookup">
      <div className="callsign-actions">
        <button
          type="button"
          className="btn"
          onClick={() => void run()}
          disabled={phase.kind === 'busy' || typed === ''}
        >
          {phase.kind === 'busy' ? 'Looking up…' : 'Look up this callsign'}
        </button>
      </div>
      <p className="callsign-hint">
        Reads the FCC licence record published by callook.info. Nothing is filled in, and nothing
        is saved, until you say so.
      </p>

      {/* Always mounted, so an assistive technology is already watching it when an answer
          lands rather than being handed a node that appeared from nowhere. */}
      <p className="callsign-live" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>

      {phase.kind === 'failed' && (
        <section className="callsign-panel callsign-quiet" aria-labelledby={`${baseId}-failed`}>
          <h2 id={`${baseId}-failed`}>The lookup did not run</h2>
          <p className="callsign-note">
            Nothing on this form was changed, and GrantSpotter is not saying anything about this
            callsign either way. {phase.message}
          </p>
          <div className="callsign-actions">
            <button type="button" className="btn" onClick={() => setPhase({ kind: 'idle' })}>
              Close
            </button>
          </div>
        </section>
      )}

      {answered !== null && record === null && (
        <NonFoundPanel
          id={`${baseId}-status`}
          /* `found` with no record is a malformed answer, and it is framed as
             `unavailable` — which is what it is from here: no record was received, so
             there is nothing to show and nothing is claimed about the callsign. */
          frame={frameFor(answered.status === 'found' ? 'unavailable' : answered.status, typed)}
          message={answered.message}
          onClose={() => setPhase({ kind: 'idle' })}
        />
      )}

      {record !== null && (
        <FoundPanel
          // Remounts on a fresh answer, so the editable values below are re-seeded from the
          // record rather than carrying the previous callsign's state forward.
          key={`${record.callsign}:${record.fetchedAt}`}
          baseId={baseId}
          record={record}
          target={target}
          clubNotice={clubNotice}
          onUse={(values) => {
            onAccept(values);
            setPhase({ kind: 'accepted', record });
          }}
          onDiscard={() => setPhase({ kind: 'idle' })}
        />
      )}

      {phase.kind === 'accepted' && (
        <section className="callsign-panel" aria-labelledby={`${baseId}-accepted`}>
          <h2 id={`${baseId}-accepted`}>Filled in from the FCC record</h2>
          <SourceLine record={phase.record} />
          <p className="callsign-note">
            These are values GrantSpotter read, not values you stated, and the fields are marked
            that way until you edit them. Nothing has been saved yet.
          </p>
          <div className="callsign-actions">
            <button type="button" className="btn" onClick={() => setPhase({ kind: 'idle' })}>
              Close
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

function NonFoundPanel({
  id,
  frame,
  message,
  onClose,
}: {
  id: string;
  frame: Frame;
  message?: string;
  onClose: () => void;
}): JSX.Element {
  return (
    // `callsign-quiet` on every one of these: none of the four is a failure of the user's,
    // and `not_us` in particular must not be dressed as an error.
    <section className="callsign-panel callsign-quiet" aria-labelledby={id}>
      <h2 id={id}>{frame.heading}</h2>
      <p className="callsign-note">{frame.body}</p>
      {/* The server's own sentence, unedited, beneath the framing rather than instead of it. */}
      {message !== undefined && message !== '' && <p className="callsign-note">{message}</p>}
      <div className="callsign-actions">
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </section>
  );
}

/**
 * The record, and the three values that may leave it.
 *
 * The editable inputs are the "edit" half of accept/edit/dismiss: they open pre-filled from
 * the record, and what the user presses "Use these values" with is what the host receives.
 * Everything above them is evidence — shown so a person can recognise their own record, and
 * then discarded.
 */
function FoundPanel({
  baseId,
  record,
  target,
  clubNotice,
  onUse,
  onDiscard,
}: {
  baseId: string;
  record: CallsignRecord;
  target: CallsignTarget;
  clubNotice?: ReactNode;
  onUse: (values: AcceptedCallsign) => void;
  onDiscard: () => void;
}): JSX.Element {
  const [state, setState] = useState(record.state ?? '');
  // UNSET unless the source's class maps exactly. This is the legacy-class rule in one line:
  // `operClass` is absent for Advanced, Novice and Technician Plus, and an empty select is
  // what makes the user the one who decides.
  const [licenseClass, setLicenseClass] = useState<string>(record.operClass ?? '');
  const [orgName, setOrgName] = useState(record.type === 'CLUB' ? record.name : '');

  /** A licence class is a person's, and only the student profile has a field for one. */
  const offersLicenseClass = target === 'student' && record.type === 'PERSON';
  /** An organisation name is a club's, and only the organisation profile has a field for one. */
  const offersOrgName = target === 'organization' && record.type === 'CLUB';

  const addressLines = [
    record.addressLine1,
    [record.city, record.state].filter((part) => part !== undefined && part !== '').join(', '),
    record.zip,
  ].filter((line): line is string => line !== undefined && line !== '');

  function use(): void {
    const trimmedState = state.trim().toUpperCase();
    const trimmedOrg = orgName.trim();
    onUse({
      callsign: record.callsign,
      type: record.type,
      ...(trimmedState === '' ? {} : { state: trimmedState }),
      ...(licenseClass !== '' && isLicenseClass(licenseClass) ? { licenseClass } : {}),
      ...(offersOrgName && trimmedOrg !== '' ? { orgName: trimmedOrg } : {}),
      provenance: {
        source: record.source,
        fetchedAt: record.fetchedAt,
        ...(record.ulsUrl === undefined ? {} : { ulsUrl: record.ulsUrl }),
      },
    });
  }

  return (
    <section className="callsign-panel" aria-labelledby={`${baseId}-found`}>
      <h2 id={`${baseId}-found`}>{frameFor('found', record.callsign).heading}</h2>

      <dl className="callsign-facts">
        <dt>Licensee</dt>
        <dd>{record.name}</dd>

        <dt>Station</dt>
        <dd>{record.type === 'CLUB' ? 'Club station' : 'Individual'}</dd>

        <dt>Operator class</dt>
        <dd>{operatorClassText(record)}</dd>

        {record.grantDate !== undefined && (
          <>
            {/* NOT "licensed since", and the label is the entire reason this is safe to show.
                The grant date resets on every renewal and every vanity change, so a real
                record can show a 2019 grant beside a callsign the operator held for decades
                — and beside a PREVIOUS callsign of theirs. */}
            <dt>Current licence granted</dt>
            <dd>{formatDate(record.grantDate)}</dd>
          </>
        )}

        {record.expiryDate !== undefined && (
          <>
            <dt>Expires</dt>
            <dd>{formatDate(record.expiryDate)}</dd>
          </>
        )}

        {record.frn !== undefined && (
          <>
            <dt>FRN</dt>
            <dd>{record.frn}</dd>
          </>
        )}
      </dl>

      {addressLines.length > 0 && (
        <div className="callsign-address">
          <address>{addressLines.join('\n')}</address>
          <p className="callsign-note">
            The address is here so you can confirm this is your record.
            {record.isPoBox ? ' The FCC record gives a PO box rather than a street address.' : ''}{' '}
            GrantSpotter does not store it: there is no field for a street address and nothing in
            the product reads one. Only the state below is kept, because eligibility rules are
            written in terms of states, ARRL Divisions and ARRL Sections.
          </p>
        </div>
      )}

      <SourceLine record={record} />

      {record.type === 'CLUB' && clubNotice !== undefined && (
        <p className="callsign-choose">{clubNotice}</p>
      )}

      <div className="callsign-fill">
        <p className="callsign-note">
          Check these before you use them, and change anything that is wrong. They are the only
          values that leave this panel.
        </p>

        <div className="callsign-fill-field">
          <label htmlFor={`${baseId}-state`}>State to fill in</label>
          <input
            id={`${baseId}-state`}
            type="text"
            maxLength={2}
            value={state}
            onChange={(event) => setState(event.target.value)}
          />
        </div>

        {offersLicenseClass && (
          <div className="callsign-fill-field">
            <label htmlFor={`${baseId}-class`}>License class to fill in</label>
            <select
              id={`${baseId}-class`}
              value={licenseClass}
              onChange={(event) => setLicenseClass(event.target.value)}
            >
              <option value="">Leave unset</option>
              {LICENSE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* The legacy classes, named. Novice, Advanced and Technician Plus are no longer
            issued and are still held, and every operator holding one would otherwise be
            silently rounded to a class the FCC never granted them. */}
        {offersLicenseClass && record.operClass === undefined && (
          <p className="callsign-choose">
            The record gives the operator class as <strong>{operatorClassText(record)}</strong>.
            GrantSpotter matches against None, Technician, General and Amateur Extra only, and
            that is not one of them, so nothing has been chosen for you — pick the class you want
            to be matched against, or leave it unset and answer it later.
          </p>
        )}

        {offersOrgName && (
          <div className="callsign-fill-field">
            <label htmlFor={`${baseId}-org`}>Organization name to fill in</label>
            <input
              id={`${baseId}-org`}
              type="text"
              value={orgName}
              onChange={(event) => setOrgName(event.target.value)}
            />
          </div>
        )}

        <div className="callsign-actions">
          <button type="button" className="btn btn-primary" onClick={use}>
            Use these values
          </button>
          <button type="button" className="btn" onClick={onDiscard}>
            Discard
          </button>
        </div>
      </div>
    </section>
  );
}

/** Where the values came from, when, and the link that lets the user check us. */
function SourceLine({ record }: { record: CallsignRecord }): JSX.Element {
  return (
    <p className="callsign-source">
      Read from <strong>{record.source}</strong> on {formatDate(record.fetchedAt)}, which
      republishes the FCC&rsquo;s licence database.{' '}
      {record.ulsUrl === undefined ? (
        <>GrantSpotter did not receive a link to the FCC&rsquo;s own page for this record.</>
      ) : (
        <>
          Check it against the FCC yourself:{' '}
          <a href={record.ulsUrl} target="_blank" rel="noopener noreferrer">
            this record in the FCC ULS
          </a>
          .
        </>
      )}{' '}
      The grant date is when the current licence was granted — it resets on renewal and on a
      vanity change — so GrantSpotter never fills &ldquo;licensed since&rdquo; from it.
    </p>
  );
}
