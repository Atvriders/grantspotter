export type ProfileFieldKind = 'student' | 'organization';

/**
 * What a callsign lookup is allowed to do with this field.
 *
 * ABSENT is the third state and the common one: the FCC record has no bearing on the field at all,
 * and nobody would expect it to (`gpa`, `stage`, `memberCount`). The two states below are for the
 * fields where the answer is not obvious, and `'refused'` exists because those are exactly the
 * fields somebody will otherwise fill from something that looks close enough. Carrying the reason
 * as DATA rather than as a comment is the point: a comment can be deleted by the person who
 * disagrees with it, and the sentence here is one the editor can show the applicant when they ask
 * why the lookup left a field blank.
 */
export type CallsignFill =
  | { kind: 'fills' }
  | { kind: 'refused'; because: string };

export interface ProfileFieldMeta {
  key: string;
  kind: ProfileFieldKind;
  label: string;
  help: string;
  /**
   * The registry's half of the rule; `StudentFieldSources`/`OrgFieldSources` in core are the
   * schema's half, and `profileFields.test.ts` asserts the two agree in both directions.
   */
  callsignFill?: CallsignFill;
}

/**
 * The single registry behind three things: the profile editor forms, the
 * completeness meter, and the "click a missing field to go fix it" links on
 * unknown verdicts. Keys match the CONTRACT StudentProfile / OrgProfile fields
 * exactly - the matcher reports those names verbatim, and
 * `profileFields.test.ts` asserts both directions against core's zod mirrors so
 * a field added to the contract cannot arrive here unlabelled.
 *
 * FOUR KEYS APPEAR TWICE, once per kind: `callsign`, `state`, `lat`, `lon` are
 * fields of BOTH `StudentProfile` and `OrgProfile`, and the matcher's geography
 * axis reads all four for an organisation exactly as it does for a student.
 * Listing them under `student` alone (as this task's brief did) leaves the
 * organisation editor with no input for them — Task 22 renders
 * `PROFILE_FIELDS.filter(f => f.kind === kind)` — so an org's geography
 * `unknown` would be permanently unresolvable and its "fix it" link would open
 * the student tab. Their label and help text are IDENTICAL in both entries, so
 * the `PROFILE_FIELDS.find(f => f.key === …)` lookups in Tasks 18 and 22, which
 * cannot know the kind, can never show kind-wrong copy.
 */
export const PROFILE_FIELDS: ProfileFieldMeta[] = [
  // `fills`, and only for the one case in which the callsign is an ANSWER rather than the question:
  // callook answers a lookup of a superseded callsign with the licensee's CURRENT record, so
  // accepting a record found for K9OLD writes W5NEW here. That value came from the source and the
  // applicant never typed it, so it must be storable as one — see `StudentFieldSources.callsign`.
  // A record whose callsign IS the one they typed carries no marker: `fillFromLookup` marks only
  // values whose origin is `'source'`, and `callsignFromRecord` labels that case `'user'`.
  { key: 'callsign', kind: 'student', label: 'Callsign', help: 'Your FCC-issued station identifier, for example W8UM. Funders use it to confirm you hold a licence.', callsignFill: { kind: 'fills' } },
  // The help text said "110 of the 111 ARRL catalog entries gate on it". Two things were wrong
  // with that. It was a census in copy nobody re-measures, which is the defect
  // `test/cycleCountCopy.test.ts` exists to stop — and it was also simply false: 110 is how many
  // catalog entries carry an INSTITUTION constraint. Every one of the 111 carries a licence one
  // (measured over `data/seed/` by constraint axis). The qualitative claim is what the field
  // actually needs to convey, and it cannot go stale.
  { key: 'licenseClass', kind: 'student', label: 'License class', help: 'NONE, TECH, GENERAL or EXTRA. These rank in that order, and most awards here gate on it — including every entry in the ARRL scholarship catalog.', callsignFill: { kind: 'fills' } },
  {
    key: 'licensedSince', kind: 'student', label: 'Licensed since',
    help: 'The date you were first licensed. Several awards require the licence to be held for a minimum period.',
    // The trap this annotation exists to close: the FCC record does carry a date, it is right
    // beside the licence class, and it is the WRONG date. `licensedSince` feeds `heldMonthsMin`,
    // so filling it from the grant date would turn a renewal into a confidently wrong ELIGIBLE.
    callsignFill: {
      kind: 'refused',
      because:
        'The FCC record grants a date, but it is not the date you were first licensed — it resets on every renewal and every vanity callsign change. Only you can say when you were first licensed.',
    },
  },
  { key: 'state', kind: 'student', label: 'State', help: 'Two-letter US state. Used for state, ARRL Division and ARRL Section rules — an ARRL Section is an ARRL-defined region that does not line up with state borders, so GrantSpotter resolves it for you.', callsignFill: { kind: 'fills' } },
  {
    key: 'county', kind: 'student', label: 'County',
    help: 'Some club scholarships name specific counties, for example seven counties around Austin, Texas.',
    callsignFill: {
      kind: 'refused',
      because: 'The FCC record carries a mailing city and state, and no county at all.',
    },
  },
  { key: 'lat', kind: 'student', label: 'Latitude', help: 'Needed only for radius rules such as "within 250 miles of Seaford, Delaware".' },
  { key: 'lon', kind: 'student', label: 'Longitude', help: 'Needed only for radius rules such as "within 70 miles of Schenectady, New York".' },
  { key: 'callDistrict', kind: 'student', label: 'Call district', help: 'The single digit in your callsign, for example 5 in K5UTD. A few awards are scoped to a call district.' },
  { key: 'fieldOfStudy', kind: 'student', label: 'Field of study', help: 'Your major. One catalog entry reads "Any, except for Liberal Arts", so exclusions matter as much as inclusions.' },
  { key: 'degreeLevel', kind: 'student', label: 'Degree level', help: 'CERT, ASSOC, BACH or GRAD.' },
  { key: 'institution', kind: 'student', label: 'Institution', help: 'The school you attend or will attend.' },
  { key: 'accredited', kind: 'student', label: 'Accredited institution', help: 'Many awards require an accredited programme; a few explicitly allow trade schools.' },
  { key: 'partTime', kind: 'student', label: 'Part-time', help: 'A small number of awards are aimed specifically at part-time students working full-time.' },
  { key: 'gpa', kind: 'student', label: 'GPA', help: 'Hard floors of 2.5, 3.0 and 3.2 appear in the catalog, and ARDC states a preference above 3.5.' },
  { key: 'classRankTopPct', kind: 'student', label: 'Class rank (top %)', help: 'Used where an award asks for class rank instead of GPA, for example the top 5 to 10 percent.' },
  { key: 'arrlMemberSince', kind: 'student', label: 'ARRL member since', help: 'A few awards require ARRL membership, and some require it for at least one year.' },
  { key: 'citizenship', kind: 'student', label: 'Citizenship', help: 'US_CITIZEN, US_RESIDENT or ANY. One award also accepts applicants within three months of citizenship.' },
  { key: 'birthDate', kind: 'student', label: 'Date of birth', help: 'Only four catalog entries state an age range, but they state it precisely, for example "22 or younger as of June 1".' },
  { key: 'stage', kind: 'student', label: 'Stage', help: 'HS_SENIOR, UNDERGRAD, GRAD, VETERAN or RETRAINING_ADULT. Veterans are explicitly included by two awards.' },
  { key: 'activityKinds', kind: 'student', label: 'Ham activity', help: 'Club membership, ARES/RACES/SKYWARN, teaching, on-air operating, Field Day, contesting, public service. Several awards require demonstrated activity, not just a licence.' },
  { key: 'cwWpm', kind: 'student', label: 'Morse code speed (wpm)', help: 'One award requires an ARRL Code Proficiency certificate at 15 words per minute or better within the last 24 months.' },
  { key: 'financialNeed', kind: 'student', label: 'Financial need', help: 'Always a weighting, never a bar. Declaring it can only help.' },
  { key: 'gender', kind: 'student', label: 'Gender', help: 'Used by exactly one funder, YLRL, whose awards are for female licensed operators.' },

  { key: 'entity', kind: 'organization', label: 'Entity type', help: 'What kind of applicant you are: unincorporated club, 501(c)(3) club, club applying through a fiscal sponsor, school, university, university department, or IEEE Student Branch Chapter.' },
  { key: 'orgName', kind: 'organization', label: 'Organization name', help: 'The name that will appear on the application.', callsignFill: { kind: 'fills' } },
  { key: 'callsign', kind: 'organization', label: 'Callsign', help: 'Your FCC-issued station identifier, for example W8UM. Funders use it to confirm you hold a licence.', callsignFill: { kind: 'fills' } },
  { key: 'state', kind: 'organization', label: 'State', help: 'Two-letter US state. Used for state, ARRL Division and ARRL Section rules — an ARRL Section is an ARRL-defined region that does not line up with state borders, so GrantSpotter resolves it for you.', callsignFill: { kind: 'fills' } },
  { key: 'lat', kind: 'organization', label: 'Latitude', help: 'Needed only for radius rules such as "within 250 miles of Seaford, Delaware".' },
  { key: 'lon', kind: 'organization', label: 'Longitude', help: 'Needed only for radius rules such as "within 70 miles of Schenectady, New York".' },
  { key: 'ein', kind: 'organization', label: 'EIN', help: 'Your federal employer identification number, if you have one.' },
  { key: 'is501c3', kind: 'organization', label: '501(c)(3)', help: 'ARDC funds US 501(c)(3) organizations, governments, schools and universities directly.' },
  { key: 'hasFiscalSponsor', kind: 'organization', label: 'Has a fiscal sponsor', help: 'Unincorporated clubs and individuals can still apply to ARDC through a fiscal sponsor — an existing nonprofit that receives the grant on your behalf.' },
  { key: 'arrlAffiliated', kind: 'organization', label: 'ARRL-affiliated club', help: 'The ARRL Club Grant Program is open only to ARRL-affiliated clubs.' },
  { key: 'memberCount', kind: 'organization', label: 'Member count', help: 'IEEE chapter support requires at least five members, and the rebate scales at $2 per member.' },
  { key: 'institutionName', kind: 'organization', label: 'Host institution', help: 'The school or university the club is attached to, if any.' },
];

/** First entry per key — student before organisation, matching the array order above. */
const BY_KEY = new Map<string, ProfileFieldMeta>();
/** Exact `kind:key` lookup, for callers that know which editor tab they are on. */
const BY_KIND_KEY = new Map<string, ProfileFieldMeta>();

for (const field of PROFILE_FIELDS) {
  if (!BY_KEY.has(field.key)) BY_KEY.set(field.key, field);
  BY_KIND_KEY.set(`${field.kind}:${field.key}`, field);
}

function lookup(key: string, kind?: ProfileFieldKind): ProfileFieldMeta | undefined {
  if (kind !== undefined) {
    const exact = BY_KIND_KEY.get(`${kind}:${key}`);
    // Falling through to the other kind is deliberate: a student-profile page asking for an
    // org-only field must still land on an input that exists, not on a dead anchor.
    if (exact !== undefined) return exact;
  }
  return BY_KEY.get(key);
}

/** The human name for a raw matcher field key. Falls back to the key, never to blank. */
export function profileFieldLabel(key: string, kind?: ProfileFieldKind): string {
  return lookup(key, kind)?.label ?? key;
}

/** The help sentence for a raw matcher field key. Empty when the key is unregistered. */
export function profileFieldHelp(key: string, kind?: ProfileFieldKind): string {
  return lookup(key, kind)?.help ?? '';
}

/**
 * The labels for a set of field keys, joined for a sentence: "State", "State and License class",
 * "Callsign, State and License class".
 *
 * One implementation, because two screens now name a set of fields TO THE APPLICANT — the lookup
 * panel's confirmation and the editor's note about what a lookup left empty — and a second copy
 * would eventually spell one of them differently from the form the applicant is reading it beside.
 */
export function profileFieldLabelList(keys: string[], kind?: ProfileFieldKind): string {
  const labels = keys.map((key) => profileFieldLabel(key, kind));
  if (labels.length < 2) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1] ?? ''}`;
}

/**
 * Deep link to the editor input that resolves this field.
 *
 * Pass `kind` whenever the caller knows which profile the verdict was computed against: four keys
 * exist on both profiles, and without it a club is sent to the student tab.
 */
export function profileFieldHref(key: string, kind?: ProfileFieldKind): string {
  const field = lookup(key, kind);
  if (field === undefined) return '/profile';
  return `/profile?kind=${field.kind}&focus=${field.key}#field-${field.key}`;
}

/**
 * The fields of one profile kind a callsign lookup may write, in registry order.
 *
 * This is the list the editor iterates when a lookup comes back; every other field it holds is the
 * applicant's to type. It is asserted equal to `Object.keys(studentFieldSourcesSchema.shape)` —
 * core's zod mirror, which is what actually decides whether a marker survives a save — so a field
 * cannot become fillable in the form without becoming storable in the schema, or the reverse.
 */
export function callsignFillableFields(kind: ProfileFieldKind): string[] {
  return PROFILE_FIELDS.filter((f) => f.kind === kind && f.callsignFill?.kind === 'fills').map(
    (f) => f.key,
  );
}

/**
 * Why a lookup will never fill this field — a sentence to show the applicant, or `undefined` when
 * there is nothing to explain.
 *
 * Only the fields somebody would reasonably expect a lookup to fill carry one. Silence here means
 * "the FCC record has nothing to do with this", not "we have not thought about it": the fields
 * where the record holds something adjacent and wrong are annotated, and `profileFields.test.ts`
 * pins which ones those are.
 */
export function callsignFillRefusal(key: string, kind?: ProfileFieldKind): string | undefined {
  const fill = lookup(key, kind)?.callsignFill;
  return fill?.kind === 'refused' ? fill.because : undefined;
}
