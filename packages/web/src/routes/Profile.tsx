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
import {
  callsignFillableFields,
  callsignFillCaveat,
  callsignFillDerivation,
  profileFieldLabelList,
  PROFILE_FIELDS,
  type ProfileFieldMeta,
} from '../lib/profileFields.js';
import {
  derivedProfileValues,
  fillFromLookup,
  type AcceptedCallsign,
} from '../lib/callsignFill.js';
import {
  profileValueOrigin,
  pruneFieldSources,
  type Profile as StoredProfile,
  type ProfileFieldSource,
} from '@grantspotter/core';
import { CallsignLookup } from '../components/CallsignLookup.js';
import { formatDate } from '../lib/trust.js';
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

/**
 * The provenance markers held for one tab, WITH THE CALLSIGN WHOSE RECORD STATED THEM.
 *
 * The markers themselves are core's and are in exactly the shape the profile is STORED with: they
 * ride along with the values they describe in the PUT body and come back on the next load, so a
 * licence class a lookup wrote is still distinguishable from one the applicant typed a week later.
 * Nothing here clears a marker when the user edits a FIELD: `profileValueOrigin` compares the
 * marker's stored value against what the field now holds, so an edit invalidates it by arithmetic
 * rather than by some code path remembering to.
 *
 * What core's marker cannot say is WHO the value is about. It carries the source, the day and the
 * value — never the licensee — and every value a lookup writes is a fact about ONE licensee: the
 * holder of the callsign that was looked up. So a marker that outlives the callsign beside it stops
 * describing this applicant altogether. Accept the record for W8UM, type K5UTD over the callsign,
 * and the profile went on saying `state` was read from callook.info: true of W8UM's licensee, and a
 * statement about somebody else on a profile that is now K5UTD's. The matcher reads `state` and
 * `licenseClass`.
 *
 * Pairing the two in one value makes that unrepresentable — there is no way to install a marker set
 * without saying which callsign it is about — and `liveMarks` compares that callsign against the one
 * in the field rather than trusting any path to have remembered. It is the marker's own `value`
 * device one level up: a marker self-invalidates when the VALUE changes, this pair when the SUBJECT
 * does.
 *
 * `readFor` is not persisted, and does not need to be: markers are only ever SAVED while they agree
 * with the callsign in the form (see `save`), so a stored set always describes the callsign stored
 * beside it and `sourcesOf` rebuilds the pair from the two of them on the next load.
 */
interface TabSources {
  /** The callsign the record these markers were read from was for. */
  readFor: string;
  marks: Record<string, ProfileFieldSource>;
  /**
   * WHAT THE RECORD STATED THAT NO MARKER CAN DESCRIBE — the coordinate, and only ever that.
   *
   * `fillFromLookup.unmarkable` is where these come from, and the reason they need a home here at
   * all is that a marker is what everything else on this screen reads. `lat` and `lon` have no key
   * in core's `StudentFieldSources`, `z.object` strips what it does not declare, so a marker built
   * for a coordinate is dropped by the server on the way in — and every mechanism this component
   * has for saying "a lookup put that there" is built on markers. Without this, a coordinate a
   * lookup wrote would be indistinguishable from a typed one the moment it landed, and a SECOND
   * lookup would leave the first licensee's coordinate sitting in the form, which is the exact
   * two-people-on-one-profile defect `vacated` exists to prevent for the marked fields.
   *
   * NOT PERSISTED, and that is not a shortcut — there is nowhere to persist it to. The honest
   * consequence is stated on screen rather than papered over: while the lookup is still in this
   * session the field says where its number came from, and after a reload the profile holds a
   * coordinate it cannot attribute to anybody. Which is the caveat the registry carries for
   * `lat`/`lon`, shown beside the field whether or not this map has an entry.
   */
  unattributed: Record<string, string>;
  /**
   * Who stated the values in `unattributed`, and when — the half a `ProfileFieldSource` would have
   * carried if one could exist for these fields.
   *
   * Kept beside them rather than per-field because there is exactly one answer per accepted
   * record, which is the same reason the banner above the form reads it off whichever marker it
   * finds first. `undefined` until a record is accepted on this tab, which makes it the honest
   * test for "has a lookup happened here" — the marker set cannot answer that on its own, since a
   * record whose only usable answer is a coordinate produces no markers at all.
   */
  readFrom?: { source: string; fetchedAt: string };
}

type FieldSources = Record<ProfileKind, TabSources>;

const NO_SOURCES: FieldSources = {
  student: { readFor: '', marks: {}, unattributed: {} },
  organization: { readFor: '', marks: {}, unattributed: {} },
};

/** The markers a stored profile arrived with, paired with the callsign stored beside them. */
function sourcesOf(saved: Record<string, unknown> | null): TabSources {
  const raw = saved?.fieldSources;
  const callsign = saved?.callsign;
  return {
    readFor: typeof callsign === 'string' ? callsign : '',
    marks:
      typeof raw === 'object' && raw !== null ? (raw as Record<string, ProfileFieldSource>) : {},
    // A stored profile carries no record of which of its numbers were fetched, because the schema
    // has nowhere to keep that. Empty is the truthful answer, not a placeholder for one.
    unattributed: {},
  };
}

/**
 * Callsign identity, which is neither case- nor whitespace-sensitive: `w8um ` and `W8UM` are one
 * licence, and the lookup panel normalises exactly this way before asking about one. Comparing raw
 * strings would take a whole tab's marks off because somebody released the shift key — a badge
 * disappearing for a reason the user cannot see, which is the same class of defect pointed the
 * other way.
 */
function sameCallsign(a: string, b: string): boolean {
  return a.trim().toUpperCase() === b.trim().toUpperCase();
}

export function Profile(): JSX.Element {
  const [searchParams] = useSearchParams();
  const kindParam = searchParams.get('kind');
  const focusKey = searchParams.get('focus');

  const [kind, setKind] = useState<ProfileKind>(
    kindParam === 'organization' ? 'organization' : 'student',
  );
  const [drafts, setDrafts] = useState<Record<ProfileKind, FormValues>>(EMPTY_DRAFTS);
  const [sources, setSources] = useState<FieldSources>(NO_SOURCES);
  /**
   * The link to the FCC's own copy of the record last looked up on each tab.
   *
   * Deliberately NOT persisted, because `ProfileFieldSource` has no room for it: the stored
   * marker carries the source, the day and the value it wrote, which is what makes it
   * self-invalidating. So the link is offered while the lookup is still on screen, and after a
   * reload the banner still names the source and the day it read them — it just cannot hand
   * out a link nobody stored. Reconstructing a ULS URL from a callsign would be this tool
   * inventing a citation.
   */
  const [ulsUrls, setUlsUrls] = useState<Record<ProfileKind, string | undefined>>({
    student: undefined,
    organization: undefined,
  });
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
    // The markers travel with the profile, so a value a lookup wrote is still marked as one on
    // every later visit — not only in the minute after the button was pressed.
    setSources({ student: sourcesOf(data.student), organization: sourcesOf(data.organization) });
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

  /**
   * The markers that still describe THIS applicant — none of them, once the callsign in the form
   * is no longer the one whose record stated them.
   *
   * The set is HELD rather than deleted and COMPARED rather than cleared, for the same reason
   * `profileValueOrigin` compares the marker's value instead of trusting an `onChange` to clear a
   * flag: nothing has to remember, and a callsign typed back is the same licence again, which
   * callook did state these values for. A change of callsign destroys nothing — the VALUES a
   * lookup wrote stay in the form either way, because they are on screen and the applicant may
   * well have meant to keep them. What it takes away is the source's name on them, which was never
   * about this callsign.
   */
  const forThisCallsign = sameCallsign(drafts[kind].callsign ?? '', sources[kind].readFor);
  const liveMarks = forThisCallsign ? sources[kind].marks : {};
  /**
   * The same rule as `liveMarks`, applied to the values a marker cannot describe. A coordinate
   * read for W8UM stops being described as read for W8UM the moment the callsign in the form is
   * somebody else's — the number stays, exactly as a marked value's does, and only the claim about
   * where it came from goes.
   */
  const liveUnattributed = forThisCallsign ? sources[kind].unattributed : {};

  function setValue(key: string, value: string): void {
    setDrafts((current) => {
      const draft = current[kind];
      const next: FormValues = { ...draft, [key]: value };
      /**
       * A DERIVED VALUE FOLLOWS THE FIELD IT IS DERIVED FROM, OR IT IS A THIRD KIND OF STALE MARK.
       *
       * `callDistrict` is the digit in the callsign. Change W8UM to K5UTD and an 8 left sitting in
       * the district box is a fact about the licence the applicant no longer holds — the same
       * defect as a provenance marker that outlives its callsign, which this component already
       * carries `readFor` to prevent, and which the matcher would read straight into a
       * `call_district` verdict.
       *
       * Recomputed by COMPARISON rather than by remembering, exactly as `profileValueOrigin`
       * works: the district is replaced only where the box is empty or still holds what the
       * PREVIOUS callsign implied. A district the applicant typed themselves differs from both and
       * is left alone, and clearing the callsign clears a district that was derived from it.
       * Nothing has to be flagged, so no path can forget to unflag it.
       */
      const before = derivedProfileValues(kind, { callsign: draft.callsign ?? '' });
      const after = derivedProfileValues(kind, { callsign: next.callsign ?? '' });
      for (const [derivedKey, derivedValue] of Object.entries(after)) {
        // Editing the derived box itself makes the value the applicant's, whatever it is.
        if (derivedKey === key) continue;
        const held = draft[derivedKey] ?? '';
        if (held === '' || held === before[derivedKey]) next[derivedKey] = derivedValue;
      }
      return { ...current, [kind]: next };
    });
    // No marker is touched here, and that is the design rather than an omission: a marker
    // holds the value it wrote, so `profileValueOrigin` reports this field as the user's the
    // moment its value differs. A flag cleared by hand is a flag some path forgets to clear.
  }

  /**
   * The user pressed "Use these values" in the lookup panel.
   *
   * Everything here is written into the DRAFT, never to the server: the profile is saved by
   * the same Save button as every other edit, so a lookup the user changes their mind about
   * costs nothing. The street address is not among these values and has nowhere to go — see
   * `CallsignLookup`, which shows it and drops it.
   *
   * WHICH values get a marker is not this screen's decision to make, and it used to be: this
   * function stamped the record's provenance onto every fillable field it wrote, including the
   * ones the user had just edited inside the panel. `fillFromLookup` decides instead, from the
   * origin each value carries — see `lib/callsignFill.ts`, which is the only place a marker is
   * built, and which marks only what the source itself stated.
   *
   * The markers it returns REPLACE the ones held, rather than merging into them, and they arrive
   * paired with the callsign they are about. What this profile has read from a source is exactly
   * what the record just accepted stated, for the licensee that record names — a marker left from
   * an earlier record is either the same licensee's (in which case this record restated it and it
   * is back) or somebody else's.
   */
  function applyLookup(accepted: AcceptedCallsign): void {
    const { values, fieldSources, unmarkable } = fillFromLookup(accepted, kind);
    const held = sources[kind].marks;
    const heldUnattributed = sources[kind].unattributed;
    const draft = drafts[kind];

    /**
     * The fields the PREVIOUS record filled that this one says nothing about.
     *
     * This is what "use these values" has to mean when the record's answer is nothing. A second
     * lookup whose record is silent on a field — an address callook could not parse, one of the
     * ~212k legacy operator classes that maps onto none of GrantSpotter's four — used to leave the
     * first licensee's `MI` and `GENERAL` sitting in the form. Dropping the marker alone would fix
     * the attribution and leave the value, which is the worse half of the same problem: the state
     * the matcher reads would still be the other licensee's, now indistinguishable from something
     * this applicant typed.
     *
     * A field is emptied ONLY where it still holds exactly what a marker says a lookup put there.
     * `profileValueOrigin` is core's reader and answers `'typed'` the moment the applicant has
     * changed it, so what this clears is the previous RECORD's answer and never the applicant's
     * own — a state they typed before pressing the button survives a lookup that is silent on it.
     */
    const vacated: FormValues = {};
    for (const [key, mark] of Object.entries(held)) {
      if (values[key] !== undefined) continue;
      if (profileValueOrigin(draft[key], mark) === 'looked_up') vacated[key] = '';
    }
    /**
     * The same clearing, for the values a marker cannot describe.
     *
     * `profileValueOrigin` cannot be used here because there is no marker to hand it; the
     * comparison it makes is available anyway, because this component kept the value the previous
     * lookup wrote. So the test is identical in substance — the field still holds exactly what the
     * previous record put there, therefore what is being cleared is that record's answer and not
     * the applicant's. Without this, looking up a second callsign whose record states no
     * coordinate would leave the first licensee's mail-drop coordinate in the form, feeding radius
     * verdicts, with nothing on screen tying it to anybody.
     */
    for (const [key, previous] of Object.entries(heldUnattributed)) {
      if (values[key] !== undefined) continue;
      if ((draft[key] ?? '') === previous) vacated[key] = '';
    }

    // Emptying a field the applicant can see is a change they are owed a sentence about, in the
    // live region this form already keeps mounted. Silence here would be the same defect as the
    // one above pointed the other way: a value that moves without the person being told.
    const emptied = Object.keys(vacated);
    setStatus(
      emptied.length === 0
        ? ''
        : `The record you accepted does not state ${profileFieldLabelList(emptied, kind)}, so ` +
            `${emptied.length === 1 ? 'that field is' : 'those fields are'} now empty. What was ` +
            `in ${emptied.length === 1 ? 'it' : 'them'} came from the record read before it, not ` +
            'from you. Nothing has been saved yet.',
    );

    setDrafts((current) => ({ ...current, [kind]: { ...current[kind], ...vacated, ...values } }));
    setSources((current) => ({
      ...current,
      [kind]: {
        readFor: accepted.callsign.value,
        marks: fieldSources,
        // REPLACED rather than merged, for the reason `fieldSources` is: every value here is a
        // fact about the licensee whose record was just accepted, and keeping the previous one's
        // alongside is two people's coordinates on one profile.
        unattributed: Object.fromEntries(unmarkable.map((key) => [key, values[key] ?? ''])),
        readFrom: {
          source: accepted.provenance.source,
          fetchedAt: accepted.provenance.fetchedAt,
        },
      },
    }));
    setUlsUrls((current) => ({ ...current, [kind]: accepted.provenance.ulsUrl }));
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

    /**
     * The provenance rides along with the values it describes, and `pruneFieldSources` — core's
     * own storage rule, called rather than re-implemented — drops every marker whose value the
     * user has since typed over, and every marker for a field that is now empty. Without it a
     * "read from callook.info" marker for a value nobody can see any more would sit in the
     * database waiting for the next reader to discount it.
     *
     * `liveMarks` is what is sent rather than the held set, and it is the half `pruneFieldSources`
     * cannot do: core compares each marker against the VALUE beside it, so a marker describing
     * another licensee's record survives that pass intact — the value it names is still in the
     * field, it is just no longer a fact about the callsign on this profile.
     */
    const marks = liveMarks;
    const payload = pruneFieldSources(
      (Object.keys(marks).length === 0
        ? body
        : { ...body, fieldSources: marks }) as unknown as StoredProfile,
    );

    setSaving(true);
    try {
      const response = await apiSend<SaveResponse>('PUT', `/api/profiles/${kind}`, payload);
      setDrafts((current) => ({ ...current, [kind]: toForm(response.profile, kind) }));
      // The server's echo, so what is on screen is what is stored — including a marker the
      // schema stripped.
      setSources((current) => ({
        ...current,
        [kind]: {
          ...sourcesOf(response.profile),
          /**
           * ...except the two things the echo CANNOT carry, which are carried forward instead of
           * being dropped on the floor.
           *
           * There is no key for a coordinate's provenance anywhere in the stored profile, so
           * `sourcesOf` reads back `{}` for it — truthfully, about the database. It is not true
           * about this browser, which watched the value arrive thirty seconds ago. Dropping it
           * here would mean pressing Save silently turned a fetched coordinate into one nobody
           * could account for, and the NEXT lookup would then leave the previous licensee's
           * coordinate sitting in the form: the two-people-on-one-profile defect `vacated`
           * exists to prevent, reintroduced by an act as innocent as saving.
           *
           * A reload is where this knowledge genuinely ends, and the caveat the registry puts
           * beside `Latitude` says exactly that rather than pretending otherwise. Closing that
           * last gap needs a `lat`/`lon` key in core's `StudentFieldSources` and `OrgFieldSources`
           * — the schema is what decides, and `z.object` strips everything it does not declare.
           */
          unattributed: current[kind].unattributed,
          ...(current[kind].readFrom === undefined ? {} : { readFrom: current[kind].readFrom }),
        },
      }));
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
  /**
   * Whether this field still holds the value a lookup wrote FOR THE CALLSIGN NOW IN THE FORM.
   * `profileValueOrigin` is core's and is the only sanctioned reader of the first half: testing
   * for a marker's presence would report "read from callook.info" for a value the user has typed
   * over, which is the precise misattribution the marker's stored value exists to prevent.
   * `liveMarks` is the second half, which core's marker has no room to express — see
   * {@link TabSources}.
   */
  function lookedUpSource(key: string): ProfileFieldSource | undefined {
    const source = liveMarks[key];
    return profileValueOrigin(drafts[kind][key], source) === 'looked_up' ? source : undefined;
  }
  // Every live marker on a tab came from one lookup, so any of them names the source and day.
  const firstFilled = callsignFillableFields(kind).find(
    (key) => lookedUpSource(key) !== undefined,
  );
  const lookupMark = firstFilled === undefined ? null : (liveMarks[firstFilled] ?? null);
  /**
   * Whether a lookup has happened on this tab, which is what the per-field explanations are gated
   * on: before one there is nothing to explain, and "we did not fill this from a record you never
   * asked us to read" is noise.
   *
   * NOT `lookupMark !== null`, which is what it was. A record whose only fillable answer is a
   * coordinate — a club record accepted on the student tab with no state, say — leaves no marker
   * at all, and the fields it just wrote would then explain nothing about themselves. The
   * unattributed set is the other half of "a record was accepted here".
   */
  const readFrom = forThisCallsign ? sources[kind].readFrom : undefined;
  const lookupHappened = lookupMark !== null || readFrom !== undefined;
  /**
   * What follows RIGHT NOW from the values in the form — recomputed on every render rather than
   * stored, so the note beside a field can never outlive the value it describes. A district equal
   * to the digit in the callsign currently in the box is a derived value; anything else in that
   * box is the applicant's, including the same digit typed under a callsign that does not imply it.
   */
  const derivedNow = derivedProfileValues(kind, { callsign: drafts[kind].callsign ?? '' });
  function isDerivedValue(key: string): boolean {
    const derived = derivedNow[key];
    return derived !== undefined && derived !== '' && drafts[kind][key] === derived;
  }
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
      {/* WHICH BOXES CHANGE THE ANSWER. Thirty-five inputs is a lot to ask of somebody, and until
          this said so there was no way to tell the ones a verdict depends on from the ones that
          only ever appear on the application a funder reads. Every field below carries the answer
          for itself; this is the sentence that says the distinction exists. */}
      <p className="profile-lede">
        Not every box changes what GrantSpotter tells you. Each one below says whether matching
        reads it or whether it is there for your own records and your application — and none of
        them is required. Leaving a field empty leaves the rules that need it{' '}
        <strong>unanswered</strong>, which is not the same as answered against you.
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
          {/* Where the marked values came from, stated once, with the day and a link to the
              FCC's own copy of the record. It outlives the lookup panel on purpose: the
              panel closes, and the fields it filled are still on screen. */}
          {lookupMark !== null && (
            <p className="callsign-source">
              The marked fields below were read from <strong>{lookupMark.source}</strong> on{' '}
              {formatDate(lookupMark.fetchedAt)}. They are values GrantSpotter read, not values
              you stated.{' '}
              {ulsUrls[kind] !== undefined && (
                <a href={ulsUrls[kind]} target="_blank" rel="noopener noreferrer">
                  Check this record in the FCC ULS
                </a>
              )}
              {ulsUrls[kind] !== undefined ? '. ' : ''}
              Editing one makes it yours, and the mark comes off.
            </p>
          )}

          {fieldsFor(kind).map((field) => {
            const id = `field-${field.key}`;
            const helpId = `${id}-help`;
            const value = drafts[kind][field.key] ?? '';
            const isRequired = REQUIRED[kind] === field.key;
            const mark = lookedUpSource(field.key);
            /**
             * ONE SENTENCE PER FIELD, CHOSEN FROM FOUR, AND THE ORDER IS THE ARGUMENT.
             *
             * There used to be two — a lookup filled this, or a lookup will never fill this and
             * here is why — and the two fields this round is about fitted neither. A coordinate
             * IS filled by a lookup and CANNOT be marked; a call district is filled by nobody and
             * computed from the box above it. Both were silent, which on a screen whose whole
             * business is saying where values came from is the same as claiming the applicant
             * typed them.
             *
             *   1. marked        the record stated it and the profile can say so. Strongest claim,
             *                    so it is tested first.
             *   2. unattributed  the record stated it and nothing can record that. Named with the
             *                    source and the day while this session lasts, and honest about
             *                    what happens after: the caveat from the registry, which is
             *                    attached to the field permanently rather than to this event.
             *   3. derived       GrantSpotter computed it from another field of this form.
             *   4. caveat        nothing was filled: either a standing refusal (`licensedSince`,
             *                    `county`) or the coordinate rule explaining why a lookup left
             *                    this empty.
             *
             * `derived` is NOT gated on a lookup having happened, unlike the rest: the arithmetic
             * runs on a hand-typed callsign too, and a value that appeared in a box the applicant
             * did not type in has to explain itself the moment it appears.
             */
            const fetchedValue = liveUnattributed[field.key];
            const isFetched = fetchedValue !== undefined && fetchedValue === value && value !== '';
            const derivation = isDerivedValue(field.key)
              ? callsignFillDerivation(field.key, kind)
              : undefined;
            const caveat = lookupHappened ? callsignFillCaveat(field.key, kind) : undefined;
            const note =
              mark !== undefined
                ? `Read from ${mark.source} — not a value you stated. Edit it and it becomes yours.`
                : isFetched && readFrom !== undefined
                  ? `Read from ${readFrom.source} on ${formatDate(readFrom.fetchedAt)}, and ` +
                    'carrying no mark, because GrantSpotter cannot record where a coordinate came ' +
                    'from. Once you save, this reads exactly like a value you stated.'
                  : derivation !== undefined
                    ? derivation.because
                    : caveat;
            /**
             * WHETHER A VERDICT CAN DEPEND ON THIS BOX, said per field rather than in a legend
             * somebody has to hold in their head while they scroll.
             *
             * Part of the field's DESCRIPTION, like the note, and for the same reason: a
             * screen-reader user filling in thirty-five inputs is the person this distinction
             * helps most, and a badge floating beside the label is one they never hear.
             */
            const matcherId = `${id}-matcher`;
            const matcherNote = field.usedInMatching
              ? 'Used in matching: an answer here can change your verdicts.'
              : 'Not used in matching. GrantSpotter never reads this to decide a verdict — it is ' +
                'for your own records and for the application itself.';
            // The note is part of the field's DESCRIPTION, not decoration beside it: a
            // screen-reader user has to hear that this value was read for them too.
            const describedBy = [helpId, matcherId, note === undefined ? '' : `${id}-lookup`]
              .filter((part) => part !== '')
              .join(' ');

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
                    aria-describedby={`${helpId} ${matcherId}`}
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
                  {/* `profile-help`, deliberately: this is help text, it wants exactly the
                      styling help text has, and a new class would be a colour nothing in
                      `contrast.test.ts` has measured. The distinction between the two sentences
                      is carried by the WORDS, which is also the only way it reaches a reader who
                      cannot see the styling at all. */}
                  <span className="profile-help" id={matcherId}>
                    {matcherNote}
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
                    aria-describedby={describedBy}
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
                    aria-describedby={describedBy}
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
                    aria-describedby={describedBy}
                    onChange={(event) => setValue(field.key, event.target.value)}
                  />
                )}
                <span className="profile-help" id={helpId}>
                  {field.help}
                </span>
                {/* See the note on the checkbox group's copy of this: `profile-help` on purpose. */}
                <span className="profile-help" id={matcherId}>
                  {matcherNote}
                </span>
                {note !== undefined && (
                  <span
                    /* `callsign-filled` is the "a source put this here" styling. A fetched
                       coordinate gets it too — it IS a fetched value — and a derived district
                       does not, because nobody fetched anything. */
                    className={mark === undefined && !isFetched ? 'profile-help' : 'callsign-filled'}
                    id={`${id}-lookup`}
                  >
                    {note}
                  </span>
                )}
                {field.key === 'callsign' && (
                  <CallsignLookup
                    callsign={value}
                    target={kind}
                    onAccept={applyLookup}
                    clubNotice={
                      kind === 'student'
                        ? 'This is a club station licence, not an individual one. GrantSpotter ' +
                          'keeps a club on the Organization tab, which is where an organisation ' +
                          'name and the entity type funders ask for belong. The callsign and ' +
                          'state can still be used here.'
                        : 'This is a club station licence, which is what a collegiate club’s ' +
                          'callsign is. A club licence carries no operator class, so there is ' +
                          'none to fill in — the organisation name below goes straight onto this ' +
                          'profile.'
                    }
                  />
                )}
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
