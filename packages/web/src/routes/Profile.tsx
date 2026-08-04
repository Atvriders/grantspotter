import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApi } from '../store/useApi.js';
import { apiSend, ApiError } from '../api/client.js';
import { CompletenessMeter } from '../components/CompletenessMeter.js';
import {
  EMPTY_COMPLETENESS,
  unevaluatedProfileKinds,
  type CompletenessReport,
  type ProfileKind,
} from '../store/session.js';
import { PROFILE_FIELDS, type ProfileFieldMeta } from '../lib/profileFields.js';
import '../components/profile.css';

type FormValues = Record<string, string>;

interface ProfilesResponse {
  student: Record<string, unknown> | null;
  organization: Record<string, unknown> | null;
  /** Optional so an older server degrades to "nothing was measured" rather than to a guess. */
  completenessFor?: ProfileKind | null;
  completeness: CompletenessReport;
}

interface SaveResponse {
  profile: Record<string, unknown>;
  completenessFor?: ProfileKind | null;
  completeness: CompletenessReport;
}

/**
 * Enumerated inputs. The option VALUES are the contract's own literals, checked against
 * `packages/core/src/schema.ts`; the text beside them is for people. `''` is the unset
 * option and is never sent — see `toPayload`.
 */
const SELECTS: Record<string, string[]> = {
  licenseClass: ['NONE', 'TECH', 'GENERAL', 'EXTRA'],
  degreeLevel: ['CERT', 'ASSOC', 'BACH', 'GRAD'],
  citizenship: ['US_CITIZEN', 'US_RESIDENT', 'ANY'],
  stage: ['HS_SENIOR', 'UNDERGRAD', 'GRAD', 'VETERAN', 'RETRAINING_ADULT'],
  gender: ['female', 'male', 'other', 'prefer_not_to_say'],
  entity: [
    'individual',
    'club_unincorporated',
    'club_501c3',
    'club_via_fiscal_sponsor',
    'school_lea',
    'university',
    'university_dept',
    'ieee_student_branch_chapter',
    'teacher',
    'nominated_by_institution',
  ],
};

/** Human text for the enum literals above, and for the ham-activity checkboxes. */
const OPTION_LABELS: Record<string, string> = {
  NONE: 'None — not licensed',
  TECH: 'Technician',
  GENERAL: 'General',
  EXTRA: 'Amateur Extra',
  CERT: 'Certificate, trade or professional school',
  ASSOC: 'Associate degree',
  BACH: "Bachelor's degree",
  GRAD: 'Graduate degree',
  US_CITIZEN: 'US citizen',
  US_RESIDENT: 'US permanent resident',
  ANY: 'Any citizenship',
  HS_SENIOR: 'High-school senior',
  UNDERGRAD: 'Undergraduate',
  VETERAN: 'Veteran',
  RETRAINING_ADULT: 'Adult returning to school',
  female: 'Female',
  male: 'Male',
  other: 'Other',
  prefer_not_to_say: 'Prefer not to say',
  individual: 'Individual',
  club_unincorporated: 'Radio club, unincorporated',
  club_501c3: 'Radio club with 501(c)(3) status',
  club_via_fiscal_sponsor: 'Radio club applying through a fiscal sponsor',
  school_lea: 'School or school district',
  university: 'University or college',
  university_dept: 'University department',
  ieee_student_branch_chapter: 'IEEE Student Branch Chapter',
  teacher: 'Teacher',
  nominated_by_institution: 'Nominated by an institution',
  club_member: 'Club member',
  ares_races_skywarn: 'ARES, RACES or SKYWARN',
  teaching: 'Teaching',
  on_air: 'On-air operating',
  field_day: 'Field Day',
  contesting: 'Contesting',
  public_service: 'Public service',
};

/** `stage: 'GRAD'` and `degreeLevel: 'GRAD'` are different enums that share a literal. */
const STAGE_LABELS: Record<string, string> = { ...OPTION_LABELS, GRAD: 'Graduate student' };

const ACTIVITY_KINDS = [
  'club_member',
  'ares_races_skywarn',
  'teaching',
  'on_air',
  'field_day',
  'contesting',
  'public_service',
];

const NUMBERS = new Set(['gpa', 'classRankTopPct', 'lat', 'lon', 'cwWpm', 'memberCount']);
const BOOLEANS = new Set([
  'accredited',
  'partTime',
  'financialNeed',
  'is501c3',
  'hasFiscalSponsor',
  'arrlAffiliated',
]);
const DATES = new Set(['licensedSince', 'arrlMemberSince', 'birthDate']);
const ARRAYS = new Set(['activityKinds']);

/**
 * The one field on either profile that zod marks REQUIRED (`orgProfileSchema.entity`).
 * Without it every organization save is a 422, so the form refuses locally and says why
 * rather than round-tripping to collect the refusal.
 */
const REQUIRED: Partial<Record<ProfileKind, string>> = { organization: 'entity' };

function fieldsFor(kind: ProfileKind): ProfileFieldMeta[] {
  return PROFILE_FIELDS.filter((field) => field.kind === kind);
}

function toForm(saved: Record<string, unknown> | null, kind: ProfileKind): FormValues {
  const out: FormValues = {};
  for (const field of fieldsFor(kind)) {
    const value = saved?.[field.key];
    out[field.key] =
      value === undefined || value === null
        ? ''
        : Array.isArray(value)
          ? value.join(',')
          : String(value);
  }
  return out;
}

export interface Payload {
  body: Record<string, unknown>;
  /** Fields whose text is not a number. Dropping them silently would discard user input. */
  notNumbers: string[];
}

/**
 * Empty means UNSET and is omitted, never sent as `''`. That distinction is the whole
 * reason the booleans are tri-state selects rather than checkboxes: an unset field yields
 * `unknown`, while a stated `false` is a real answer the matcher may act on, and a
 * checkbox would send `false` for every box the user never looked at.
 *
 * Only the current kind's fields are read. Four keys (`callsign`, `state`, `lat`, `lon`)
 * exist on both profiles and the editor keeps a separate draft per tab, so an unscoped
 * sweep would post the student draft's values under the organization's kind.
 */
export function toPayload(kind: ProfileKind, values: FormValues): Payload {
  const body: Record<string, unknown> = { kind };
  const notNumbers: string[] = [];
  for (const field of fieldsFor(kind)) {
    const raw = values[field.key] ?? '';
    if (raw === '') continue;
    if (NUMBERS.has(field.key)) {
      const n = Number(raw);
      if (Number.isFinite(n)) body[field.key] = n;
      else notNumbers.push(field.label);
      continue;
    }
    if (BOOLEANS.has(field.key)) {
      body[field.key] = raw === 'true';
      continue;
    }
    if (ARRAYS.has(field.key)) {
      body[field.key] = raw.split(',').filter((entry) => entry !== '');
      continue;
    }
    body[field.key] = raw;
  }
  return { body, notNumbers };
}

const EMPTY_DRAFTS: Record<ProfileKind, FormValues> = { student: {}, organization: {} };

export function Profile(): JSX.Element {
  const [searchParams] = useSearchParams();
  const kindParam = searchParams.get('kind');
  const focusKey = searchParams.get('focus');

  const [kind, setKind] = useState<ProfileKind>(
    kindParam === 'organization' ? 'organization' : 'student',
  );
  const [drafts, setDrafts] = useState<Record<ProfileKind, FormValues>>(EMPTY_DRAFTS);
  const [held, setHeld] = useState<Record<ProfileKind, boolean>>({
    student: false,
    organization: false,
  });
  const [report, setReport] = useState<CompletenessReport>(EMPTY_COMPLETENESS);
  const [measuredFor, setMeasuredFor] = useState<ProfileKind | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const hydrated = useRef(false);
  const focused = useRef(false);

  const { data, error: loadError } = useApi<ProfilesResponse>('/api/profiles');

  // Hydrate once. A second pass would overwrite whatever the user has typed since, and
  // — because the PUT reply names the profile just saved while GET names the priority
  // one — would also flip the meter back off the profile the user just measured.
  useEffect(() => {
    if (data === null || hydrated.current) return;
    hydrated.current = true;
    setLoaded(true);
    setDrafts({
      student: toForm(data.student, 'student'),
      organization: toForm(data.organization, 'organization'),
    });
    setHeld({ student: data.student !== null, organization: data.organization !== null });
    setReport(data.completeness);
    const server = data.completenessFor ?? null;
    setMeasuredFor(server);
    // The open tab follows the server's answer to "which profile does the meter speak
    // for?" unless the caller named one in the URL. Defaulting to `student` here would
    // be the browser re-deriving PROFILE_KIND_PRIORITY, which is exactly the second
    // definition profileStore.ts exists to prevent.
    if (kindParam === null && server !== null) setKind(server);
  }, [data, kindParam]);

  // The completeness a tab switch alone can now obtain, via 2a1a9c3's `?profile=`. Only
  // requested when the open tab is a profile the user HOLDS but the current report does
  // not speak for: asking for a profile that is NOT held would come back
  // `completenessFor: null` (`loadActiveProfile`'s contract — a named preference that is
  // not on file answers null rather than falling back to whichever one is) and would wipe
  // out a perfectly good measurement of the OTHER profile for no reason. Once the fetch
  // below lands, `kind === measuredFor` and this goes quiet again — including right after
  // a save, since the PUT reply already set `measuredFor` to the kind just saved. That is
  // what keeps this from ever re-GETting on top of a save and flipping the meter back off
  // the profile the user just measured, the one thing the PUT-doesn't-re-GET design in
  // profileRouter.ts exists to prevent.
  //
  // This never touches `drafts` or `held`. The whole reason the hydration effect above
  // only ever runs once is that a GET response overwriting `drafts` erases whatever the
  // user has typed on the tab they are leaving; a completeness-only refetch must not
  // reopen that hole either, so it only ever calls `setReport` / `setMeasuredFor`.
  const needsMeterRefetch = loaded && kind !== measuredFor && held[kind];
  const { data: meterData } = useApi<ProfilesResponse>(
    needsMeterRefetch ? `/api/profiles?profile=${kind}` : null,
  );

  useEffect(() => {
    if (meterData === null) return;
    setReport(meterData.completeness);
    setMeasuredFor(meterData.completenessFor ?? null);
    // A failed refetch surfaces only as `useApi`'s own (unread) `error` here, on purpose:
    // the draft and the last-good report are already on screen, and the empty-form guard
    // below (`loadError !== null && !loaded`) is wired to the FIRST load only. A flaky
    // background refetch must not be able to disable Save or blank a form that already
    // loaded successfully — see Profile.test.tsx for the case this is pinned against.
  }, [meterData]);

  // Once, on arrival from an unknown verdict. Re-running it on every keystroke (the
  // obvious `[focusKey, values]` dependency) yanks focus back out of whatever field the
  // user moved to and re-scrolls the page under them.
  useEffect(() => {
    if (focusKey === null || focused.current) return;
    // `focus` is a URL parameter, so it is escaped before it reaches a selector: an
    // unregistered key must miss, not throw a SyntaxError that blanks the page.
    const escaped =
      typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
        ? CSS.escape(focusKey)
        : focusKey.replace(/[^A-Za-z0-9_-]/g, '');
    const el = formRef.current?.querySelector<HTMLElement>(`#field-${escaped}`);
    if (!el) return;
    focused.current = true;
    el.focus();
    // jsdom does not implement scrollIntoView, and neither do some embedded browsers.
    if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' });
  }, [focusKey, kind]);

  function setValue(key: string, value: string): void {
    setDrafts((current) => ({ ...current, [kind]: { ...current[kind], [key]: value } }));
  }

  function toggleActivity(value: string, on: boolean): void {
    const current = (drafts[kind].activityKinds ?? '').split(',').filter((v) => v !== '');
    const next = on ? [...current, value] : current.filter((v) => v !== value);
    setValue('activityKinds', next.join(','));
  }

  async function save(): Promise<void> {
    setStatus('');
    setError(null);

    const required = REQUIRED[kind];
    if (required !== undefined && (drafts[kind][required] ?? '') === '') {
      setError(
        'Choose an entity type. It is the one field an organization profile cannot be stored without, because it is what decides which programs are open to you at all.',
      );
      return;
    }

    const { body, notNumbers } = toPayload(kind, drafts[kind]);
    if (notNumbers.length > 0) {
      setError(`These fields need a number: ${notNumbers.join(', ')}. Nothing was saved.`);
      return;
    }

    setSaving(true);
    try {
      const response = await apiSend<SaveResponse>('PUT', `/api/profiles/${kind}`, body);
      setDrafts((current) => ({ ...current, [kind]: toForm(response.profile, kind) }));
      setHeld((current) => ({ ...current, [kind]: true }));
      setReport(response.completeness);
      // The kind the SERVER echoed, not the tab this component happens to be on.
      setMeasuredFor(response.completenessFor ?? kind);
      setStatus(`${kind === 'student' ? 'Student' : 'Organization'} profile saved. Completeness is now measured against it.`);
    } catch (err) {
      // A transport failure is not a rejected value. Telling someone their entries were
      // "not accepted" when the API was simply unreachable sends them to edit correct
      // data — the same false-cause defect Task 15's Login had to have removed.
      if (err instanceof ApiError && err.status !== 0) {
        setError(
          err.code === 'validation_failed'
            ? `One of these values was not accepted: ${err.message}`
            : `The profile was not saved. ${err.message}`,
        );
      } else {
        setError('The profile was not saved: the GrantSpotter API could not be reached.');
      }
    } finally {
      setSaving(false);
    }
  }

  function onTabKey(event: React.KeyboardEvent<HTMLButtonElement>): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    setKind(kind === 'student' ? 'organization' : 'student');
  }

  const noun = kind === 'student' ? 'student' : 'organization';
  const unevaluated = unevaluatedProfileKinds({
    hasStudentProfile: held.student,
    hasOrgProfile: held.organization,
    completenessFor: measuredFor,
  });

  return (
    <>
      <p className="eyebrow">Matching</p>
      <h1>Profile</h1>
      <p className="profile-lede">
        You may hold both a student profile and an organization profile. Every verdict is
        computed from one of them at a time — browse, the calendar and the meter beside this
        form each name the profile they used — so holding both lets you switch between two
        views of the corpus rather than merging them into one.
      </p>

      <div className="profile-tabs" role="tablist" aria-label="Profile kind">
        {(['student', 'organization'] as ProfileKind[]).map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            id={`tab-${tab}`}
            aria-selected={kind === tab}
            /* Only the SELECTED tab names a panel. One panel is in the DOM at a time, so the
               unselected tab's `aria-controls` pointed at an id that did not exist — and a
               dangling IDREF does not degrade to the element's text, it simply resolves to
               nothing. Caught by the global audit in `test/a11y.test.tsx`. */
            aria-controls={kind === tab ? `panel-${tab}` : undefined}
            tabIndex={kind === tab ? 0 : -1}
            onKeyDown={onTabKey}
            onClick={() => setKind(tab)}
          >
            {tab === 'student' ? 'Student' : 'Organization'}
          </button>
        ))}
      </div>

      <div className="profile-grid">
        <form
          ref={formRef}
          className="card profile-form"
          id={`panel-${kind}`}
          role="tabpanel"
          aria-labelledby={`tab-${kind}`}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {fieldsFor(kind).map((field) => {
            const id = `field-${field.key}`;
            const helpId = `${id}-help`;
            const value = drafts[kind][field.key] ?? '';
            const isRequired = REQUIRED[kind] === field.key;

            if (ARRAYS.has(field.key)) {
              const chosen = value.split(',').filter((v) => v !== '');
              return (
                <div className="profile-field" key={field.key}>
                  <span className="profile-legend" id={`${id}-label`}>
                    {field.label}
                  </span>
                  <div
                    className="profile-checks"
                    role="group"
                    id={id}
                    tabIndex={-1}
                    aria-labelledby={`${id}-label`}
                    aria-describedby={helpId}
                  >
                    {ACTIVITY_KINDS.map((activity) => (
                      <label key={activity}>
                        <input
                          type="checkbox"
                          value={activity}
                          checked={chosen.includes(activity)}
                          onChange={(event) => toggleActivity(activity, event.target.checked)}
                        />
                        {OPTION_LABELS[activity]}
                      </label>
                    ))}
                  </div>
                  <span className="profile-help" id={helpId}>
                    {field.help}
                  </span>
                </div>
              );
            }

            const options = SELECTS[field.key];
            return (
              <div className="profile-field" key={field.key}>
                <label htmlFor={id}>
                  {field.label}
                  {isRequired && (
                    <span className="profile-required" aria-hidden="true">
                      {' '}
                      *
                    </span>
                  )}
                </label>
                {options !== undefined ? (
                  <select
                    id={id}
                    value={value}
                    // `aria-required`, not `required`. The native attribute makes the
                    // browser cancel the submit and show its own bubble ("Please select
                    // an item in the list"), which never reaches the alert below and
                    // never says WHY the field is the one an organization cannot be
                    // stored without. Announcing it here keeps one explanation.
                    aria-required={isRequired}
                    aria-describedby={helpId}
                    onChange={(event) => setValue(field.key, event.target.value)}
                  >
                    <option value="">{isRequired ? 'Choose one' : 'Not stated'}</option>
                    {options.map((option) => (
                      <option key={option} value={option}>
                        {(field.key === 'stage' ? STAGE_LABELS : OPTION_LABELS)[option] ?? option}
                      </option>
                    ))}
                  </select>
                ) : BOOLEANS.has(field.key) ? (
                  // Three states, not two: unset, yes, no. See `toPayload`.
                  <select
                    id={id}
                    value={value}
                    aria-describedby={helpId}
                    onChange={(event) => setValue(field.key, event.target.value)}
                  >
                    <option value="">Not stated</option>
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </select>
                ) : (
                  <input
                    id={id}
                    type={NUMBERS.has(field.key) ? 'number' : DATES.has(field.key) ? 'date' : 'text'}
                    step={field.key === 'gpa' ? '0.01' : undefined}
                    value={value}
                    aria-describedby={helpId}
                    onChange={(event) => setValue(field.key, event.target.value)}
                  />
                )}
                <span className="profile-help" id={helpId}>
                  {field.help}
                </span>
              </div>
            );
          })}

          {/* The inputs render before the request returns so a `?focus=` jump lands
              immediately — but an empty box the user has not emptied is not their
              profile. Saving on top of a load that failed would replace the stored
              record with a form nobody filled in, so it is refused and said out loud. */}
          {loadError !== null && !loaded && (
            <p role="alert" className="profile-alert">
              Your saved profile could not be loaded, so this form is not showing it. Saving
              now would replace what is stored with an empty form, so saving is off until the
              profile loads. {loadError.message}
            </p>
          )}
          {error !== null && (
            <p role="alert" className="profile-alert">
              {error}
            </p>
          )}
          {/* Mounted always, so the confirmation is an update to a live region an
              assistive technology is already watching rather than a new node it may
              never announce. */}
          <p role="status" className="profile-status">
            {status}
          </p>

          <div>
            <button type="submit" className="btn btn-primary" disabled={saving || !loaded}>
              {saving ? 'Saving…' : `Save ${noun} profile`}
            </button>
          </div>
        </form>

        <div>
          {/* No meter until there is a report. Rendering the empty one while the request
              is in flight puts "0%. No profile has been measured yet." in front of a user
              whose profile scores 92 — an assertion made from ignorance, which is the one
              thing every surface in this product is built not to do. */}
          {loaded ? (
            <CompletenessMeter
              report={report}
              measuredFor={measuredFor}
              unevaluated={unevaluated}
              editing={kind}
            />
          ) : (
            <section className="card profile-meter" aria-labelledby="completeness-heading">
              <h2 id="completeness-heading">Completeness</h2>
              <p className="profile-meter-for">
                {loadError === null
                  ? 'Measuring your profile against the corpus…'
                  : 'The completeness report could not be loaded, so nothing is claimed about your profile.'}
              </p>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
