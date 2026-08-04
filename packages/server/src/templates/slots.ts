import type { Funder, OrgProfile, Profile, Program, StudentProfile } from '@grantspotter/core';

export interface SlotDef {
  path: string;
  label: string;
  /** Appears inside the [TODO: …] marker, so it must tell the writer what to supply. */
  hint: string;
  source: 'profile' | 'program' | 'user';
}

export const SLOT_VOCABULARY: readonly SlotDef[] = [
  // ---- club / organization ----
  { path: 'club.name', label: 'Club or organization name', hint: 'the full legal or published name of the applying club', source: 'profile' },
  { path: 'club.callsign', label: 'Club callsign', hint: "your club's FCC callsign, e.g. W8UM", source: 'profile' },
  { path: 'club.city', label: 'City', hint: 'the city the club operates from, e.g. Ann Arbor', source: 'user' },
  { path: 'club.state', label: 'State', hint: 'two-letter state code, e.g. MI', source: 'profile' },
  { path: 'club.memberCount', label: 'Member count', hint: 'a headcount you can defend if asked, e.g. 34', source: 'profile' },
  { path: 'club.foundedYear', label: 'Year founded', hint: 'the year the club was founded, e.g. 1909', source: 'user' },
  { path: 'club.institution', label: 'Host institution', hint: 'the school or university that hosts the club', source: 'profile' },
  { path: 'club.arrlAffiliated', label: 'ARRL affiliation', hint: 'whether the club is an ARRL-affiliated club', source: 'profile' },
  { path: 'club.ein', label: 'EIN', hint: 'the nine-digit federal EIN, or leave blank if the club has none', source: 'profile' },
  { path: 'club.fiscalSponsor', label: 'Fiscal sponsor', hint: 'the 501(c)(3) that would receive the funds on your behalf', source: 'user' },

  // ---- individual applicant ----
  { path: 'student.name', label: 'Applicant name', hint: 'the name that appears on your application', source: 'user' },
  { path: 'student.callsign', label: 'Applicant callsign', hint: 'your own callsign, e.g. KD9XYZ', source: 'profile' },
  { path: 'student.licenseClass', label: 'License class', hint: 'NONE, TECH, GENERAL or EXTRA', source: 'profile' },
  { path: 'student.licensedSince', label: 'First licensed', hint: 'the date you were first licensed, e.g. 2023-04-11', source: 'profile' },
  { path: 'student.institution', label: 'School', hint: 'the accredited institution you attend or will attend', source: 'profile' },
  { path: 'student.degreeLevel', label: 'Degree level', hint: 'CERT, ASSOC, BACH or GRAD', source: 'profile' },
  { path: 'student.fieldOfStudy', label: 'Field of study', hint: 'your declared major or intended major', source: 'profile' },
  { path: 'student.gradYear', label: 'Expected graduation year', hint: 'the year you expect to graduate, e.g. 2029', source: 'user' },
  { path: 'student.gpa', label: 'GPA', hint: 'your current GPA on a 4.0 scale', source: 'profile' },
  { path: 'student.state', label: 'State of residence', hint: 'two-letter state code for where you live', source: 'profile' },

  // ---- named people ----
  { path: 'team.leadName', label: 'Project lead', hint: 'the person accountable for delivering the work', source: 'user' },
  { path: 'team.leadCallsign', label: 'Project lead callsign', hint: "the project lead's callsign, if they hold one", source: 'user' },
  { path: 'team.leadRole', label: 'Project lead role', hint: 'their role, e.g. club president or trustee', source: 'user' },
  { path: 'team.instructorName', label: 'Instructor or faculty advisor', hint: 'the person who teaches or supervises, with their role', source: 'user' },

  // ---- the project ----
  { path: 'project.title', label: 'Project title', hint: 'a plain title a reviewer can repeat back, under 12 words', source: 'user' },
  { path: 'project.problem', label: 'What breaks today', hint: 'the specific failure, naming the object and when it started', source: 'user' },
  { path: 'project.summary', label: 'One-paragraph summary', hint: 'what you will do, for whom, by when, in three sentences', source: 'user' },
  { path: 'project.requestAmount', label: 'Amount requested', hint: 'the dollar amount you are asking this funder for', source: 'user' },
  { path: 'project.budgetTotal', label: 'Total project cost', hint: 'the total cost including money from every source', source: 'user' },
  { path: 'project.startDate', label: 'Start date', hint: 'the date work begins, e.g. 2027-01-15', source: 'user' },
  { path: 'project.endDate', label: 'End date', hint: 'the date work finishes, e.g. 2027-06-30', source: 'user' },
  { path: 'project.beneficiaryCount', label: 'People served', hint: 'how many people this reaches, counted not estimated', source: 'user' },
  { path: 'project.deliverable', label: 'Primary deliverable', hint: 'the one thing that exists afterwards that does not exist now', source: 'user' },
  { path: 'project.equipment', label: 'Equipment', hint: 'model numbers and quantities, e.g. one Icom IC-7300', source: 'user' },
  { path: 'project.openLicense', label: 'Open license', hint: 'GPL-3.0, MIT, BSD-3-Clause, CERN-OHL-S-2.0 or CC-BY-4.0', source: 'user' },
  { path: 'project.indirectPct', label: 'Indirect cost percentage', hint: 'the indirect rate you are charging, as a number', source: 'user' },
  { path: 'project.coFunder', label: 'Co-funder', hint: 'the other organization putting money or goods in', source: 'user' },
  { path: 'project.coFunderAmount', label: 'Co-funder amount', hint: 'what the co-funder is contributing, in dollars', source: 'user' },
  { path: 'project.venue', label: 'Where the work happens', hint: 'the building and room, e.g. Room 214, Engineering Building', source: 'user' },
  { path: 'project.schedule', label: 'Schedule', hint: 'the recurring dates and times, e.g. Saturdays 10:00-12:00', source: 'user' },

  // ---- the funder, derived from the opportunity record ----
  { path: 'funder.name', label: 'Funder name', hint: 'the funding organization, from the opportunity record', source: 'program' },
  { path: 'funder.programName', label: 'Program name', hint: 'the specific program, from the opportunity record', source: 'program' },
  { path: 'funder.applyUrl', label: 'Application URL', hint: 'the published application link', source: 'program' },
  // Added by Task 2. `applyVia` has three routes that publish no URL at all
  // (`email_pdf_packet`, `contact_person`, `none`), and for those the contact IS the
  // where-to-apply fact. Without this slot, a template written for a by-post funder can only ask
  // for a URL that does not exist — which is the invitation that put a stranger's Facebook page
  // in 345 award records.
  { path: 'funder.applyContact', label: 'Application contact', hint: 'the published contact to apply through, from the opportunity record', source: 'program' },
  { path: 'funder.amountRaw', label: 'Published award amount', hint: 'the amount exactly as the funder published it', source: 'program' },
  { path: 'funder.deadlineNote', label: 'Published deadline note', hint: 'the deadline exactly as the funder published it', source: 'program' },

  // ---- IEEE chapter facts ----
  { path: 'chapter.memberCount', label: 'Chapter member count', hint: 'IEEE MTT-S requires at least 5 chapter members', source: 'user' },
  { path: 'chapter.meetingCount', label: 'Meetings reported', hint: 'meetings reported in vTools this year; at least 2 are required', source: 'user' },
  { path: 'chapter.officerRosterUrl', label: 'vTools officer roster', hint: 'the vTools URL showing your current officer roster', source: 'user' },

  // ---- NASA Space Grant ----
  { path: 'consortium.name', label: 'Space Grant consortium', hint: 'your state consortium, e.g. Michigan Space Grant Consortium', source: 'user' },
  { path: 'consortium.url', label: 'Consortium website', hint: "the consortium's own site, where its deadlines live", source: 'user' },

  // ---- Yaesu repeater ----
  { path: 'repeater.site', label: 'Repeater site', hint: 'the building or tower the repeater will live on', source: 'user' },
  { path: 'repeater.frequency', label: 'Repeater pair', hint: 'the coordinated output and input frequencies', source: 'user' },
  { path: 'repeater.coordinator', label: 'Frequency coordinator', hint: 'the coordinating body that issued the pair', source: 'user' },

  // ---- campus student government ----
  { path: 'sga.fundingBody', label: 'Funding body', hint: 'the exact committee or account, e.g. RSO Allocation', source: 'user' },
  { path: 'sga.eventDate', label: 'Event date', hint: 'the date of the event you are funding', source: 'user' },
  { path: 'sga.attendanceEstimate', label: 'Expected attendance', hint: 'how many students you expect, and how you got that number', source: 'user' },

  // ---- reporting ----
  { path: 'report.periodStart', label: 'Report period start', hint: 'the first date this report covers', source: 'user' },
  { path: 'report.periodEnd', label: 'Report period end', hint: 'the last date this report covers', source: 'user' },
  { path: 'report.grantId', label: 'Grant reference', hint: "the funder's grant or award number", source: 'user' },
  { path: 'report.spendToDate', label: 'Spent to date', hint: 'dollars spent so far against the awarded budget', source: 'user' },
  { path: 'report.outcomeSummary', label: 'Outcome summary', hint: 'what actually happened, with the counts you promised', source: 'user' },

  // ---- correspondence ----
  { path: 'recommender.name', label: 'Recommender name', hint: 'the person you are asking for a letter', source: 'user' },
  { path: 'recommender.role', label: 'Recommender role', hint: 'their title and how they know your work', source: 'user' },
  { path: 'recommender.deadline', label: 'Letter deadline', hint: 'the date their letter must reach the funder', source: 'user' },
  { path: 'donor.contactName', label: 'Funder contact', hint: 'the named person at the funder you are writing to', source: 'user' },
] as const;

const BY_PATH = new Map<string, SlotDef>(SLOT_VOCABULARY.map((s) => [s.path, s]));

export function slotDef(path: string): SlotDef | undefined {
  return BY_PATH.get(path);
}

/** Vocabulary membership — "is this a slot at all", NOT "do we know its value". */
export function isKnownSlot(path: string): boolean {
  return BY_PATH.has(path);
}

export function userAnswerSlots(): SlotDef[] {
  return SLOT_VOCABULARY.filter((s) => s.source === 'user');
}

/** Who said so. Answers outrank the profile, which outranks nothing. */
export type SlotOrigin = 'profile' | 'program' | 'answer';

/**
 * THREE STATES, NEVER TWO.
 *
 * - `known`         — somebody stated this, and `value` is what they stated.
 * - `unknown`       — nobody has stated it. The applicant must supply it, and until they do the
 *                     template renders `[TODO: …]` there.
 * - `not_applicable`— the applicant's own stated facts make the slot meaningless: a high-school
 *                     senior has no club member count, an unlicensed applicant has no callsign,
 *                     a club has no GPA.
 *
 * Collapsing the last two is how filler gets written. It is the same three-way core already draws
 * for funder facts — `Obligations.costShareRequired` is documented "`true` required · `false` the
 * funder said it is not required · absent unstated" — after 148 records asserted "no cost share
 * required" that no funder had ever said.
 *
 * `not_applicable` is advice for the slot form and the fact checklist. It NEVER produces a context
 * value, so it can never hide a gap: if a template uses the slot anyway, `fillTemplate` still
 * renders the `[TODO: …]` marker. The worst case of a wrong applicability call is a misleading
 * explanation, never a silently dropped fact.
 */
export type SlotKnowledge =
  | { state: 'known'; value: unknown; origin: SlotOrigin }
  | { state: 'unknown' }
  | { state: 'not_applicable'; reason: string };

/** Total over `SLOT_VOCABULARY`: every declared slot path has an entry. */
export type SlotKnowledgeMap = Record<string, SlotKnowledge>;

export interface SlotContextInput {
  profile?: Profile;
  program?: Program;
  funder?: Funder;
  /** Free-text answers keyed by full dotted slot path. Unknown keys are ignored. */
  answers?: Record<string, string>;
}

/**
 * The missing-value test, deliberately identical to the one Plan 4's Global Constraints state and
 * `renderSlotValue` (Task 3) applies: "An empty string, a whitespace-only string, `null`,
 * `undefined`, an empty array, and any object all count as unknown." If the two layers disagreed,
 * a value could enter the context here and render as a `[TODO: …]` there — a slot the fact
 * checklist believes is answered and the document shows as a hole.
 */
function present(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.some(present);
  return false;
}

const NO_URL_ROUTES: ReadonlySet<Program['applyVia']> = new Set([
  'email_pdf_packet',
  'contact_person',
  'none',
]);

/**
 * Classify every slot in the vocabulary against what this applicant and this opportunity record
 * actually say. This is the source of truth; `buildSlotContext` is its `known` projection.
 */
export function describeSlotKnowledge(input: SlotContextInput): SlotKnowledgeMap {
  const map: SlotKnowledgeMap = {};
  for (const slot of SLOT_VOCABULARY) map[slot.path] = { state: 'unknown' };

  /** Record a stated fact. A missing value is left alone — silence is not a statement. */
  const know = (path: string, value: unknown, origin: SlotOrigin): void => {
    if (!isKnownSlot(path)) return;
    if (!present(value)) return;
    map[path] = { state: 'known', value: typeof value === 'string' ? value.trim() : value, origin };
  };

  /** Record that the applicant's own stated facts rule this slot out. */
  const notApplicable = (path: string, reason: string): void => {
    if (!isKnownSlot(path)) return;
    map[path] = { state: 'not_applicable', reason };
  };

  const inNamespace = (prefix: string): SlotDef[] =>
    SLOT_VOCABULARY.filter((s) => s.path.startsWith(`${prefix}.`));

  const { profile, program, funder, answers } = input;

  // ---- 1. applicability, from facts the applicant stated about themselves ----
  //
  // Only a STATED fact may rule a slot out. An absent profile is silence about who is applying,
  // so it produces `unknown` everywhere and never `not_applicable`: narrowing on absence is the
  // mirror of Task 1's missing `appliesTo`, which silently WIDENED a template's audience.
  if (profile?.kind === 'student') {
    for (const slot of inNamespace('club')) {
      notApplicable(
        slot.path,
        'the applicant is an individual, so there is no applying organization to describe — a club applies under its own profile',
      );
    }
    if (profile.licenseClass === 'NONE') {
      notApplicable(
        'student.callsign',
        'the profile states this applicant holds no amateur licence, so there is no callsign to give',
      );
      notApplicable(
        'student.licensedSince',
        'the profile states this applicant holds no amateur licence, so there is no first-licensed date',
      );
    }
  }

  if (profile?.kind === 'organization') {
    for (const slot of inNamespace('student')) {
      notApplicable(
        slot.path,
        'the applicant is an organization, not an individual, so there is no student applicant to describe',
      );
    }
    if (profile.hasFiscalSponsor === false) {
      notApplicable(
        'club.fiscalSponsor',
        'the profile states this organization does not apply through a fiscal sponsor',
      );
    }
  }

  if (program !== undefined && !present(program.applyUrl) && NO_URL_ROUTES.has(program.applyVia)) {
    notApplicable(
      'funder.applyUrl',
      `the funder's published route is "${program.applyVia}", which is not a web form, so there is no application URL to print`,
    );
  }
  if (program?.applyVia === 'none' && !present(program.applyContact)) {
    notApplicable(
      'funder.applyContact',
      'the opportunity record states this program publishes no application route at all',
    );
  }

  // ---- 2. facts the profile states ----
  //
  // A stated value outranks an applicability rule. A profile that says both "unlicensed" and
  // "KD9XYZ" contradicts itself, and keeping what the applicant typed is the safer half of that
  // contradiction: dropping it deletes something a person deliberately entered.
  if (profile?.kind === 'organization') {
    const p: OrgProfile = profile;
    know('club.name', p.orgName, 'profile');
    know('club.callsign', p.callsign, 'profile');
    know('club.state', p.state, 'profile');
    know('club.memberCount', p.memberCount, 'profile');
    know('club.institution', p.institutionName, 'profile');
    know('club.ein', p.ein, 'profile');
    if (typeof p.arrlAffiliated === 'boolean') {
      // Rendered as prose rather than as a bare boolean because `renderSlotValue` would print
      // "yes"/"no", and a sentence reading "our club is no" is not a sentence. `false` is a fact
      // the applicant stated, so it is `known` — not silence.
      know(
        'club.arrlAffiliated',
        p.arrlAffiliated ? 'an ARRL-affiliated club' : 'not an ARRL-affiliated club',
        'profile',
      );
    }
  }

  if (profile?.kind === 'student') {
    const p: StudentProfile = profile;
    know('student.callsign', p.callsign, 'profile');
    know('student.licenseClass', p.licenseClass, 'profile');
    know('student.licensedSince', p.licensedSince, 'profile');
    know('student.institution', p.institution, 'profile');
    know('student.degreeLevel', p.degreeLevel, 'profile');
    know('student.fieldOfStudy', p.fieldOfStudy, 'profile');
    know('student.gpa', p.gpa, 'profile');
    know('student.state', p.state, 'profile');
  }

  // ---- 3. facts the opportunity record states ----
  if (program) {
    know('funder.programName', program.name, 'program');
    know('funder.applyUrl', program.applyUrl, 'program');
    know('funder.applyContact', program.applyContact, 'program');
    know('funder.amountRaw', program.amount.amountRaw, 'program');
    know('funder.deadlineNote', program.deadline.note, 'program');
  }

  if (funder) know('funder.name', funder.name, 'program');

  // ---- 4. what the applicant typed, which outranks everything ----
  //
  // Including an inapplicable slot: the applicant is the authority on their own situation, and a
  // blank answer is silence, so it clears nothing that was already known.
  for (const [key, value] of Object.entries(answers ?? {})) {
    know(key, value, 'answer');
  }

  return map;
}

/**
 * The flat context `fillTemplate` (Task 3) consumes: exactly the `known` half of
 * `describeSlotKnowledge`, keyed by dotted slot path.
 *
 * A slot that is `unknown` or `not_applicable` has NO key here — not an empty string, not a
 * placeholder, not a plausible default — so `fillTemplate` renders its `[TODO: …]` marker and the
 * gap stays visible to the person who has to sign the application.
 */
export function buildSlotContext(input: SlotContextInput): Record<string, unknown> {
  const ctx: Record<string, unknown> = {};
  for (const [path, knowledge] of Object.entries(describeSlotKnowledge(input))) {
    if (knowledge.state === 'known') ctx[path] = knowledge.value;
  }
  return ctx;
}
