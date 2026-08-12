export type ProfileFieldKind = 'student' | 'organization';

/**
 * What a callsign lookup is allowed to do with this field.
 *
 * ABSENT is the fifth state and the common one: the FCC record has no bearing on the field at all,
 * and nobody would expect it to (`gpa`, `stage`, `memberCount`). The four states below are for the
 * fields where the answer is not obvious, and `'refused'` exists because those are exactly the
 * fields somebody will otherwise fill from something that looks close enough. Carrying the reason
 * as DATA rather than as a comment is the point: a comment can be deleted by the person who
 * disagrees with it, and the sentence here is one the editor can show the applicant when they ask
 * why the lookup left a field blank.
 *
 * WHY THERE ARE FOUR AND NOT TWO. "Filled" and "refused" were the whole vocabulary until
 * 2026-08-11, and two fields did not fit either word — so they carried no annotation at all, which
 * this registry reads as "the record has nothing to do with it". Both are fields the record has a
 * great deal to do with:
 *
 *   - `lat`/`lon`. callook states a coordinate on every successful lookup, and this product threw
 *     it away for months. It CAN hold a value the record stated — that is why it is not a
 *     `'refused'` — but never one the software chose to put there: see
 *     {@link LOOKUP_FILLS_COORDINATE}. What it cannot be is MARKED: core's `StudentFieldSources`
 *     and `OrgFieldSources` declare three keys apiece and `z.object` strips the rest, so a
 *     `ProfileFieldSource` for a coordinate is dropped by the server on the way in. A badge that
 *     shows on screen and vanishes on reload is worse than no badge at all (the rule
 *     `fillFromLookup` already enforces), so the honest annotation is `'fills_unattributed'`: this
 *     can get filled from a record, and the profile cannot afterwards say who said it.
 *   - `callDistrict`. Nothing states it. It is ARITHMETIC on a field of this same profile, which
 *     is a third thing entirely from "a source said so" — and core says so out loud in
 *     `StudentFieldSources`: attributing it to callook.info "would credit a source for this tool's
 *     own arithmetic". `'derived'` names the field it comes from, which is what lets the editor
 *     recompute it when that field changes instead of leaving a stale digit behind.
 */
export type CallsignFill =
  /** The record states it, and the profile can record that it did. */
  | { kind: 'fills' }
  /**
   * The record states it and the profile CANNOT record that it did, so the value arrives
   * unattributable. `because` is shown to the applicant beside the field.
   */
  | { kind: 'fills_unattributed'; because: string }
  /** GrantSpotter computes it from `from`, another field of this same profile. */
  | { kind: 'derived'; from: string; because: string }
  /** A lookup will never fill it, and `because` is the sentence that says why. */
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
  /**
   * WHETHER A VERDICT CAN DEPEND ON THIS FIELD — required, so a new field has to answer it.
   *
   * `matcher.ts` is the only thing in this product that computes a verdict, and it reads a
   * SUBSET of the profile. The rest is real, worth collecting and goes on the application the
   * funder reads; it simply cannot change what GrantSpotter tells you. A person filling in
   * thirty-five boxes is owed the difference, because the alternative is that they treat
   * "Member count" and "GPA" as equally load-bearing and give up somewhere in the middle.
   *
   * Structural, not measured against the corpus. `false` here means matcher.ts contains no read
   * of the field at all — verified with
   * `grep -rn 'profile\.<key>' packages/core/src/`, which finds nothing anywhere in core for
   * every field marked `false`. A corpus measurement would answer a different and much weaker
   * question: dropping `state` from an organisation profile moves no verdict in today's seed
   * corpus either, because the eleven club programs in it are `geography: any` — but the matcher
   * does read it, and a corpus with one club grant scoped to a state would prove it.
   */
  usedInMatching: boolean;
}

/**
 * ONE SENTENCE, WRITTEN ONCE, FOR BOTH COORDINATES ON BOTH PROFILES.
 *
 * `profileFields.test.ts` requires a key held by both kinds to carry an identical annotation,
 * because Tasks 18 and 22 look entries up by key alone and would otherwise show whichever entry
 * happened to be listed first. Four entries sharing one constant makes that true by construction
 * rather than by four copies staying in step.
 *
 * IT HAS TO BE TRUE WITH A NUMBER IN THE BOX AND WITH THE BOX EMPTY, WHICH IT WAS NOT.
 *
 * This sentence is attached to the FIELD, permanently, not to an event — so it is read beside
 * whatever the field currently holds. Until 2026-08-11 it said the lookup "will show it without
 * filling it in", and it was measured rendering beside a Latitude box holding `42.34991837`, the
 * post office callook geocoded for W1MX. A permanent caveat contradicting the value it is attached
 * to is worse than no caveat: it teaches the reader that the sentence is boilerplate. The comment
 * on {@link callsignFillRefusal} had already named this exact failure — the split between refusal
 * and caveat exists to stop '"GrantSpotter will never fill this in" being printed over a field it
 * has just filled in' — and the caveat then went and did the same thing one word softer.
 *
 * The sentence did not get weakened to fit the behaviour. THE BEHAVIOUR CHANGED to the one the
 * sentence was already describing, because it is the right one: no arm of a lookup puts a
 * coordinate in these boxes any more, street address included. See `describeGeocode` in
 * `components/CallsignLookup.tsx` for that argument, whose short form is that the ONE thing a
 * coordinate does in this product is decide a radius rule, that it is the only value a lookup
 * writes which the profile can never afterwards attribute to anybody, and that a hard INELIGIBLE
 * verdict resting on a number nobody typed is the failure this product exists to refuse.
 *
 * WHAT IT HAS TO SAY, AND WHY ALL THREE PARTS ARE IN IT. What the number IS — callook's geocode of
 * the mailing address on the licence, which for a club filing a box number is a post office. What
 * GrantSpotter does with it — shows it, names it, and leaves the box alone. And the part this
 * profile cannot fix: there is no key for a coordinate in `StudentFieldSources` or
 * `OrgFieldSources`, so the marker every other filled field carries cannot exist here, and after
 * one save nothing distinguishes a coordinate GrantSpotter fetched from one the applicant measured.
 */
const LOOKUP_FILLS_COORDINATE: CallsignFill = {
  kind: 'fills_unattributed',
  because:
    'A callsign lookup will not fill this in for you. callook states a coordinate on every record ' +
    'it answers with, but it is a geocode of the mailing address on the licence — a post office ' +
    'where that address is a PO box, and where the post goes rather than where the station is ' +
    'even when it is a street — so GrantSpotter shows you the number, says what it is a geocode ' +
    // "…AND LEAVES THIS BOX EMPTY" WAS THE FIRST DRAFT OF THIS CLAUSE AND WAS PULLED, because it
    // is a claim about the box's CURRENT state and this sentence is permanent: measured beside a
    // Latitude box holding a coordinate the applicant had chosen in an earlier session, it read as
    // a contradiction even though nothing untrue had happened. What is invariant is who put the
    // number there, so that is what it says.
    'of, and never writes it into this box itself. Anything in this box is in it because you put ' +
    'it there. It also has nowhere to record ' +
    'that a coordinate was read rather than stated: the profile can mark a callsign, a state, a ' +
    'licence class and an organisation name that way, and not a number. So once this is saved it ' +
    'reads exactly like a coordinate you typed — which is the other reason it has to be your ' +
    'choice and not ours.',
};

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
  // values whose origin is `'source'`, and `callsignFromRecord` labels that case `'both'` — the
  // record stated it and so did the applicant, which is its own list (`restated`) and its own
  // sentence on the confirmation, because it is neither of theirs alone.
  { key: 'callsign', kind: 'student', label: 'Callsign', help: 'Your FCC-issued station identifier, for example W8UM. Funders use it to confirm you hold a licence.', callsignFill: { kind: 'fills' }, usedInMatching: true },
  // The help text said "110 of the 111 ARRL catalog entries gate on it". Two things were wrong
  // with that. It was a census in copy nobody re-measures, which is the defect
  // `test/cycleCountCopy.test.ts` exists to stop — and it was also simply false: 110 is how many
  // catalog entries carry an INSTITUTION constraint. Every one of the 111 carries a licence one
  // (measured over `data/seed/` by constraint axis). The qualitative claim is what the field
  // actually needs to convey, and it cannot go stale.
  { key: 'licenseClass', kind: 'student', label: 'License class', help: 'NONE, TECH, GENERAL or EXTRA. These rank in that order, and most awards here gate on it — including every entry in the ARRL scholarship catalog.', callsignFill: { kind: 'fills' }, usedInMatching: true },
  {
    key: 'licensedSince', kind: 'student', label: 'Licensed since',
    help: 'The date you were first licensed. Several awards require the licence to be held for a minimum period.',
    usedInMatching: true,
    // The trap this annotation exists to close: the FCC record does carry a date, it is right
    // beside the licence class, and it is the WRONG date. `licensedSince` feeds `heldMonthsMin`,
    // so filling it from the grant date would turn a renewal into a confidently wrong ELIGIBLE.
    callsignFill: {
      kind: 'refused',
      because:
        'The FCC record grants a date, but it is not the date you were first licensed — it resets on every renewal and every vanity callsign change. Only you can say when you were first licensed.',
    },
  },
  { key: 'state', kind: 'student', label: 'State', help: 'Two-letter US state. Used for state, ARRL Division and ARRL Section rules — an ARRL Section is an ARRL-defined region that does not line up with state borders, so GrantSpotter resolves it for you.', callsignFill: { kind: 'fills' }, usedInMatching: true },
  {
    key: 'county', kind: 'student', label: 'County',
    help: 'Some club scholarships name specific counties, for example seven counties around Austin, Texas.',
    usedInMatching: true,
    callsignFill: {
      kind: 'refused',
      because:
        'The FCC record carries a mailing city and state, and no county at all. A county cannot be ' +
        'worked out from the coordinate either: that needs a boundary map, and GrantSpotter has none.',
    },
  },
  { key: 'lat', kind: 'student', label: 'Latitude', help: 'Needed only for radius rules such as "within 250 miles of Seaford, Delaware".', usedInMatching: true, callsignFill: LOOKUP_FILLS_COORDINATE },
  { key: 'lon', kind: 'student', label: 'Longitude', help: 'Needed only for radius rules such as "within 70 miles of Schenectady, New York".', usedInMatching: true, callsignFill: LOOKUP_FILLS_COORDINATE },
  {
    key: 'callDistrict', kind: 'student', label: 'Call district',
    help: 'The single digit in your callsign, for example 5 in K5UTD. A few awards are scoped to a call district.',
    usedInMatching: true,
    callsignFill: {
      kind: 'derived',
      from: 'callsign',
      because:
        'GrantSpotter works this out from the callsign above — it is the digit in it — and no source ' +
        'is credited for arithmetic this tool did itself. Change the callsign and this follows it. ' +
        'The matcher does the same sum when the box is empty, so leaving it blank costs you nothing.',
    },
  },
  { key: 'fieldOfStudy', kind: 'student', label: 'Field of study', help: 'Your major. One catalog entry reads "Any, except for Liberal Arts", so exclusions matter as much as inclusions.', usedInMatching: true },
  { key: 'degreeLevel', kind: 'student', label: 'Degree level', help: 'CERT, ASSOC, BACH or GRAD.', usedInMatching: true },
  // The one student field the matcher never reads: `institution` appears in no axis. Where a
  // program cares about the school it asks whether it is ACCREDITED and at what DEGREE LEVEL,
  // which are the two fields beside this one.
  { key: 'institution', kind: 'student', label: 'Institution', help: 'The school you attend or will attend.', usedInMatching: false },
  { key: 'accredited', kind: 'student', label: 'Accredited institution', help: 'Many awards require an accredited programme; a few explicitly allow trade schools.', usedInMatching: true },
  { key: 'partTime', kind: 'student', label: 'Part-time', help: 'A small number of awards are aimed specifically at part-time students working full-time.', usedInMatching: true },
  { key: 'gpa', kind: 'student', label: 'GPA', help: 'Hard floors of 2.5, 3.0 and 3.2 appear in the catalog, and ARDC states a preference above 3.5.', usedInMatching: true },
  { key: 'classRankTopPct', kind: 'student', label: 'Class rank (top %)', help: 'Used where an award asks for class rank instead of GPA, for example the top 5 to 10 percent.', usedInMatching: true },
  { key: 'arrlMemberSince', kind: 'student', label: 'ARRL member since', help: 'A few awards require ARRL membership, and some require it for at least one year.', usedInMatching: true },
  { key: 'citizenship', kind: 'student', label: 'Citizenship', help: 'US_CITIZEN, US_RESIDENT or ANY. One award also accepts applicants within three months of citizenship.', usedInMatching: true },
  { key: 'birthDate', kind: 'student', label: 'Date of birth', help: 'Only four catalog entries state an age range, but they state it precisely, for example "22 or younger as of June 1".', usedInMatching: true },
  { key: 'stage', kind: 'student', label: 'Stage', help: 'HS_SENIOR, UNDERGRAD, GRAD, VETERAN or RETRAINING_ADULT. Veterans are explicitly included by two awards.', usedInMatching: true },
  { key: 'activityKinds', kind: 'student', label: 'Ham activity', help: 'Club membership, ARES/RACES/SKYWARN, teaching, on-air operating, Field Day, contesting, public service. Several awards require demonstrated activity, not just a licence.', usedInMatching: true },
  { key: 'cwWpm', kind: 'student', label: 'Morse code speed (wpm)', help: 'One award requires an ARRL Code Proficiency certificate at 15 words per minute or better within the last 24 months.', usedInMatching: true },
  { key: 'financialNeed', kind: 'student', label: 'Financial need', help: 'Always a weighting, never a bar. Declaring it can only help.', usedInMatching: true },
  { key: 'gender', kind: 'student', label: 'Gender', help: 'Used by exactly one funder, YLRL, whose awards are for female licensed operators.', usedInMatching: true },

  { key: 'entity', kind: 'organization', label: 'Entity type', help: 'What kind of applicant you are: unincorporated club, 501(c)(3) club, club applying through a fiscal sponsor, school, university, university department, or IEEE Student Branch Chapter.', usedInMatching: true },
  // Read by nothing in the matcher: it is who you are, not whether you qualify. It goes on the
  // application, and it is what a club record's licensee name fills in.
  { key: 'orgName', kind: 'organization', label: 'Organization name', help: 'The name that will appear on the application.', callsignFill: { kind: 'fills' }, usedInMatching: false },
  { key: 'callsign', kind: 'organization', label: 'Callsign', help: 'Your FCC-issued station identifier, for example W8UM. Funders use it to confirm you hold a licence.', callsignFill: { kind: 'fills' }, usedInMatching: true },
  { key: 'state', kind: 'organization', label: 'State', help: 'Two-letter US state. Used for state, ARRL Division and ARRL Section rules — an ARRL Section is an ARRL-defined region that does not line up with state borders, so GrantSpotter resolves it for you.', callsignFill: { kind: 'fills' }, usedInMatching: true },
  { key: 'lat', kind: 'organization', label: 'Latitude', help: 'Needed only for radius rules such as "within 250 miles of Seaford, Delaware".', usedInMatching: true, callsignFill: LOOKUP_FILLS_COORDINATE },
  { key: 'lon', kind: 'organization', label: 'Longitude', help: 'Needed only for radius rules such as "within 70 miles of Schenectady, New York".', usedInMatching: true, callsignFill: LOOKUP_FILLS_COORDINATE },
  { key: 'ein', kind: 'organization', label: 'EIN', help: 'Your federal employer identification number, if you have one.', usedInMatching: false },
  { key: 'is501c3', kind: 'organization', label: '501(c)(3)', help: 'ARDC funds US 501(c)(3) organizations, governments, schools and universities directly.', usedInMatching: false },
  { key: 'hasFiscalSponsor', kind: 'organization', label: 'Has a fiscal sponsor', help: 'Unincorporated clubs and individuals can still apply to ARDC through a fiscal sponsor — an existing nonprofit that receives the grant on your behalf.', usedInMatching: false },
  { key: 'arrlAffiliated', kind: 'organization', label: 'ARRL-affiliated club', help: 'The ARRL Club Grant Program is open only to ARRL-affiliated clubs.', usedInMatching: true },
  { key: 'memberCount', kind: 'organization', label: 'Member count', help: 'IEEE chapter support requires at least five members, and the rebate scales at $2 per member.', usedInMatching: false },
  { key: 'institutionName', kind: 'organization', label: 'Host institution', help: 'The school or university the club is attached to, if any.', usedInMatching: false },
];

/** First entry per key — student before organisation, matching the array order above. */
const BY_KEY = new Map<string, ProfileFieldMeta>();
/** Exact `kind:key` lookup, for callers that know which editor tab they are on. */
const BY_KIND_KEY = new Map<string, ProfileFieldMeta>();

for (const field of PROFILE_FIELDS) {
  if (!BY_KEY.has(field.key)) BY_KEY.set(field.key, field);
  BY_KIND_KEY.set(`${field.kind}:${field.key}`, field);
}

/**
 * The registry entry for a key, preferring the caller's kind and falling through to the other.
 *
 * THE FALL-THROUGH WAS RE-EXAMINED ON 2026-08-04 AND KEPT, and the reasoning is worth writing down
 * because it looked like the bug. A confirmation on an ORGANIZATION profile printed the label
 * "License class" — a student field — and it got that label from here: `organization:licenseClass`
 * misses, and this hands back the student entry rather than refusing.
 *
 * Refusing would not have fixed it. `profileFieldLabel` falls back to the RAW KEY, so the same
 * sentence would have read "licenseClass carries no mark" — a worse thing to show an applicant, and
 * still a field of somebody else's profile named in a sentence about theirs. It would also have
 * broken the one caller that needs this exactly as it is: `profileFieldHref` sends the user to the
 * tab that HAS the field, which is the entire reason a wrong-kind lookup is answered at all rather
 * than producing a dead anchor (asserted in `profileFields.test.ts`).
 *
 * What this function answers is "where does this field live, and what is it called there". That is
 * a question about the registry, and it has the same answer whoever asks. "Is this field one of
 * MINE" is a different question with a different answer per kind, and the caller that needed it was
 * asking this one instead — see `callsignFillableFields`, which is the predicate that decides it,
 * and `fillFromLookup`, which now partitions on that predicate before it names anything to anybody.
 */
function lookup(key: string, kind?: ProfileFieldKind): ProfileFieldMeta | undefined {
  if (kind !== undefined) {
    const exact = BY_KIND_KEY.get(`${kind}:${key}`);
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
 *
 * STRICTLY THE REFUSALS. `lat`/`lon` are annotated too and are NOT refusals — the record states a
 * coordinate, the applicant can put it in the box, and it lands there as a value the record stated
 * — so they answer `undefined` here and carry their sentence through {@link callsignFillCaveat}.
 * Keeping the two questions apart is what stops "GrantSpotter will never fill this in" being
 * printed over a field it has just filled in. That is a rule about the WORDS as much as about the
 * function: see {@link LOOKUP_FILLS_COORDINATE}, whose caveat broke it in 2026-08-11's measurement
 * while this function was answering correctly.
 */
export function callsignFillRefusal(key: string, kind?: ProfileFieldKind): string | undefined {
  const fill = lookup(key, kind)?.callsignFill;
  return fill?.kind === 'refused' ? fill.because : undefined;
}

/**
 * The sentence to show beside the field once a lookup has happened, whichever kind of annotation
 * it carries: why nothing was filled in, or what was filled in and what cannot be recorded about
 * it. `undefined` for a field with nothing to explain, and for `'fills'` — a value the profile
 * can mark needs no caveat, because the mark itself is the statement.
 */
export function callsignFillCaveat(key: string, kind?: ProfileFieldKind): string | undefined {
  const fill = lookup(key, kind)?.callsignFill;
  if (fill === undefined) return undefined;
  switch (fill.kind) {
    case 'fills':
      return undefined;
    case 'derived':
      // Shown by the editor whenever the field HOLDS the derived value, not only after a lookup —
      // the arithmetic runs on a hand-typed callsign too. See `callsignFillDerivation`.
      return undefined;
    case 'fills_unattributed':
    case 'refused':
      return fill.because;
  }
}

/**
 * The field this one is COMPUTED FROM, and the sentence that says so — or `undefined` when nothing
 * computes it.
 *
 * A value derived from another field of the same profile is a third thing beside "the source said
 * it" and "you said it", and the editor needs the name of the input it came from rather than just
 * a sentence: that is what lets it recompute the value when that input changes instead of leaving
 * a digit behind that describes somebody's previous callsign.
 */
export function callsignFillDerivation(
  key: string,
  kind?: ProfileFieldKind,
): { from: string; because: string } | undefined {
  const fill = lookup(key, kind)?.callsignFill;
  return fill?.kind === 'derived' ? { from: fill.from, because: fill.because } : undefined;
}

/** Every field key of one profile kind, in registry order — fillable or not. */
export function profileFieldKeys(kind: ProfileFieldKind): string[] {
  return PROFILE_FIELDS.filter((f) => f.kind === kind).map((f) => f.key);
}

/**
 * Can a verdict depend on this field? See {@link ProfileFieldMeta.usedInMatching}.
 *
 * An unregistered key answers `false`, which is the safe direction: the claim on screen is
 * "answering this can change your results", and a field nobody registered has no evidence for it.
 */
export function fieldUsedInMatching(key: string, kind?: ProfileFieldKind): boolean {
  return lookup(key, kind)?.usedInMatching ?? false;
}
