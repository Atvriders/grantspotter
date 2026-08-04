export type ProfileFieldKind = 'student' | 'organization';

export interface ProfileFieldMeta {
  key: string;
  kind: ProfileFieldKind;
  label: string;
  help: string;
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
  { key: 'callsign', kind: 'student', label: 'Callsign', help: 'Your FCC-issued station identifier, for example W8UM. Funders use it to confirm you hold a licence.' },
  { key: 'licenseClass', kind: 'student', label: 'License class', help: 'NONE, TECH, GENERAL or EXTRA. These rank in that order; 110 of the 111 ARRL catalog entries gate on it.' },
  { key: 'licensedSince', kind: 'student', label: 'Licensed since', help: 'The date you were first licensed. Several awards require the licence to be held for a minimum period.' },
  { key: 'state', kind: 'student', label: 'State', help: 'Two-letter US state. Used for state, ARRL Division and ARRL Section rules — an ARRL Section is an ARRL-defined region that does not line up with state borders, so GrantSpotter resolves it for you.' },
  { key: 'county', kind: 'student', label: 'County', help: 'Some club scholarships name specific counties, for example seven counties around Austin, Texas.' },
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
  { key: 'orgName', kind: 'organization', label: 'Organization name', help: 'The name that will appear on the application.' },
  { key: 'callsign', kind: 'organization', label: 'Callsign', help: 'Your FCC-issued station identifier, for example W8UM. Funders use it to confirm you hold a licence.' },
  { key: 'state', kind: 'organization', label: 'State', help: 'Two-letter US state. Used for state, ARRL Division and ARRL Section rules — an ARRL Section is an ARRL-defined region that does not line up with state borders, so GrantSpotter resolves it for you.' },
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
