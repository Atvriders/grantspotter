import type {
  ApplicantEntity,
  ApplyVia,
  DeadlineKind,
  DeadlineSpec,
  Instrument,
  MonthDay,
  OpportunityClass,
  Profile,
  Program,
  ProgramStatus,
  Recurrence,
  TimeOfDay,
} from '@grantspotter/core';
import { RECURRENCE_PREFIX, obligationState, parseRecurrence } from '@grantspotter/core';
import { fillTemplate } from '../templates/fill.js';
import { getTemplate } from '../templates/load.js';
import { buildSlotContext, slotDef } from '../templates/slots.js';
import { disclosureNote, disclosureSentence } from './disclosure.js';
import { type FragmentId, loadFragment } from './fragments.js';

export interface PromptContext {
  program: Program;
  profile?: Profile;
  templateId?: string;
  includeDisclosure: boolean;
}

/**
 * A section the brief was ASKED for and does not contain, with the reason.
 *
 * The subtitle beside the copy button enumerates the brief's contents — spec §10.2 requires the
 * enumeration — and it was a constant, so it recited "your profile facts" to every reader
 * including the ones who have no profile. Measured on the live site on 2026-08-13: a member with
 * no profile copied a 21,145-character prompt containing no "## Facts about me that you may use"
 * section at all, under a sentence promising one. An enumeration that is right most of the time is
 * worse than none, because the times it is wrong are exactly the times a reader would have acted
 * on it — this reader would have saved a profile if the screen had said their facts were missing.
 */
export interface OmittedSection {
  /** The clause as the subtitle would have printed it: "your profile facts". */
  clause: string;
  /** Why it is not there, in the same voice: "you have not saved a profile". */
  reason: string;
}

export interface PromptContents {
  prompt: string;
  /** Every clause the enumeration may claim, in the order the brief presents them. */
  included: string[];
  omitted: OmittedSection[];
}

/**
 * Rules first, then the reasoning, then the two rules that outrank everything. `why-these-rules`
 * sits after the style rules because it explains them; `never-invent` and the brevity pass sit
 * last because they are the passes the model runs over its own finished draft.
 */
const FRAGMENT_ORDER: readonly FragmentId[] = [
  'interview',
  'style-negative',
  'style-positive',
  'why-these-rules',
  'never-invent',
  'brevity',
];

/*
 * ---------------------------------------------------------------------------------------------
 * Enum labels.
 *
 * `applyVia: 'external_spa_portal'` and `deadline.kind: 'n_fixed_dates'` are storage values. This
 * brief is read by a person deciding whether to trust it and by a model asked to write from it,
 * and neither of them knows what `school_lea` means. Every map below is a `Record<Union, string>`,
 * so adding a member to the union in core fails this file at compile time rather than leaking a
 * snake_case token into the product's most visible artefact.
 * ---------------------------------------------------------------------------------------------
 */

const CLASS_LABEL: Record<OpportunityClass, string> = {
  ham_grant: 'amateur radio grant',
  ham_scholarship: 'amateur radio scholarship',
  adjacent_stem: 'adjacent STEM funding',
  equipment_in_kind: 'equipment given in kind',
};

const ENTITY_LABEL: Record<ApplicantEntity, string> = {
  individual: 'an individual',
  club_unincorporated: 'an unincorporated club',
  club_501c3: 'a club that is its own 501(c)(3)',
  club_via_fiscal_sponsor: 'a club applying through a fiscal sponsor',
  school_lea: 'a school or school district',
  university: 'a university or college',
  university_dept: 'a university department',
  ieee_student_branch_chapter: 'an IEEE student branch or chapter',
  teacher: 'a teacher applying in person',
  nominated_by_institution: 'someone nominated by their institution',
};

const APPLY_VIA_LABEL: Record<ApplyVia, string> = {
  page_form: "a form on the funder's own page",
  external_spa_portal: 'an external grants-management portal',
  jotform_year_keyed: 'a Jotform whose address changes every year',
  self_hosted_portal: "the funder's own application portal",
  email_pdf_packet: 'a PDF packet returned by email',
  contact_person: 'a named contact person',
  none: 'no application process',
};

const STATUS_LABEL: Record<ProgramStatus, string> = {
  open: 'open',
  closed: 'closed for now',
  dormant: 'dormant — no recent cycle found',
  discontinued: 'discontinued',
  contact_only: 'no published process; contact the funder',
  no_application: 'awarded without an application',
  unknown: 'unknown — GrantSpotter could not determine it',
};

const INSTRUMENT_LABEL: Record<Instrument, string> = {
  cash_range: 'cash, within a published range',
  cash_fixed: 'cash, a fixed amount',
  cash_tiered_blocks: 'cash, in tiers',
  in_kind_equipment: 'equipment, not cash',
  in_kind_service: 'a service, not cash',
  discounted_purchase: 'a discount on a purchase',
  per_member_rebate: 'a per-member rebate',
  tuition_coverage: 'tuition coverage',
  unknown: 'not stated',
};

const DEADLINE_KIND_LABEL: Record<DeadlineKind, string> = {
  n_fixed_dates: 'fixed dates each year',
  n_fixed_windows: 'several application windows each year',
  annual_window: 'one application window each year',
  rolling: 'rolling — applications are accepted at any time',
  quarterly_rewritten: 'quarterly, with the published page rewritten each round',
  ad_hoc: 'ad hoc — announced when the funder decides to run it',
  inherited: "inherited from another program's schedule",
  unpublished: 'the funder publishes no deadline',
  no_application_exists: 'there is no application to make',
  dormant: 'no cycle has run recently',
};

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function monthDay(md: MonthDay): string {
  return `${MONTHS[md.month - 1] ?? String(md.month)} ${md.day}`;
}

function timeOfDay(t: TimeOfDay): string {
  return `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
}

function describeRecurrence(r: Recurrence): string | undefined {
  switch (r.kind) {
    case 'n_fixed_dates':
      return `${r.dates.map(monthDay).join(', ')}, closing at ${timeOfDay(r.closeTime)} ${r.timezone}`;
    case 'n_fixed_windows':
      return `${r.windows
        .map((w) => `${monthDay(w.open)} to ${monthDay(w.close)}`)
        .join('; ')}, ${timeOfDay(r.openTime)} to ${timeOfDay(r.closeTime)} ${r.timezone}`;
    case 'annual_window':
      return `${monthDay(r.window.open)} to ${monthDay(r.window.close)}, ${timeOfDay(
        r.openTime,
      )} to ${timeOfDay(r.closeTime)} ${r.timezone}`;
    default:
      return undefined;
  }
}

/**
 * `DeadlineSpec.note` really carries `RECUR n_fixed_dates tz=America/Los_Angeles dates=02-01,…`,
 * with the human prose after the first `|`. That directive is a machine format: `dates=02-01` is
 * not a date anybody can read, and pasting it into the brief asks the model to interpret an
 * internal encoding. It is parsed into English here, and printed nowhere. A directive that does
 * not parse is DROPPED rather than shown, because a half-understood schedule is exactly the kind
 * of plausible-looking fact this product exists not to publish.
 */
function describeDeadline(spec: DeadlineSpec): string[] {
  const note = spec.note.trim();
  let prose = note;
  let rule: string | undefined;

  if (note.startsWith(RECURRENCE_PREFIX)) {
    const bar = note.indexOf('|');
    prose = bar === -1 ? '' : note.slice(bar + 1).trim();
    try {
      rule = describeRecurrence(parseRecurrence(note));
    } catch {
      rule = undefined;
    }
  }

  const lines = [`- Deadline: ${DEADLINE_KIND_LABEL[spec.kind]}${rule === undefined ? '' : ` — ${rule}`}`];
  if (prose !== '') lines.push(`  ${prose}`);
  if (spec.source.kind === 'inherited') {
    lines.push(
      `  This program publishes no schedule of its own; the dates above are inherited from "${spec.source.fromProgramId}".`,
    );
  }
  return lines;
}

/**
 * The three obligation states, kept as three.
 *
 * `Obligations.costShareRequired` is documented in core as "`true` required · `false` the funder
 * said it is not required · absent unstated", and 148 published records once asserted "no cost
 * share required" that no funder had ever said, because a boolean test collapses the last two.
 * Writing that collapse into an application's own brief would put the false claim in front of the
 * funder who never made it.
 */
function obligationLines(program: Program): string[] {
  const ob = program.obligations;
  const out: string[] = [];
  if (ob.licenseObligation) out.push(`- ${ob.licenseObligation}`);
  if (typeof ob.indirectCostCapPct === 'number') {
    out.push(`- Indirect costs are capped at ${ob.indirectCostCapPct}%.`);
  }

  switch (obligationState(ob.costShareRequired)) {
    case 'yes':
      out.push('- Cost share is required. Name the matching funds and quantify them.');
      break;
    case 'no':
      out.push('- The funder states that cost share is not required.');
      break;
    case 'unstated':
      out.push(
        '- The funder says nothing about cost sharing. Do not claim either way; check before the budget is written.',
      );
      break;
  }

  switch (obligationState(ob.coFunderPreference)) {
    case 'yes':
      out.push('- This funder prefers not to be the sole funder. Name and quantify every co-funder.');
      break;
    case 'no':
      out.push('- The funder states that it does not require or prefer a co-funder.');
      break;
    case 'unstated':
      out.push('- The funder says nothing about co-funding. Do not claim either way.');
      break;
  }

  if (ob.sustainmentObligation) out.push(`- ${ob.sustainmentObligation}`);
  if (ob.reportingObligation) out.push(`- ${ob.reportingObligation}`);
  return out;
}

function profileFacts(profile: Profile): string[] {
  const lines: string[] = [];
  const add = (label: string, value: unknown): void => {
    if (value === undefined || value === null || value === '') return;
    lines.push(`- ${label}: ${String(value)}`);
  };
  if (profile.kind === 'organization') {
    add('Organization', profile.orgName);
    add('Callsign', profile.callsign);
    add('Applicant type', ENTITY_LABEL[profile.entity]);
    add('State', profile.state);
    add('Host institution', profile.institutionName);
    add('Members', profile.memberCount);
    if (typeof profile.is501c3 === 'boolean') add('501(c)(3)', profile.is501c3 ? 'yes' : 'no');
    if (typeof profile.hasFiscalSponsor === 'boolean') {
      add('Has a fiscal sponsor', profile.hasFiscalSponsor ? 'yes' : 'no');
    }
    if (typeof profile.arrlAffiliated === 'boolean') {
      add('ARRL affiliated', profile.arrlAffiliated ? 'yes' : 'no');
    }
  } else {
    add('Callsign', profile.callsign);
    add('License class', profile.licenseClass);
    add('Licensed since', profile.licensedSince);
    add('Institution', profile.institution);
    add('Degree level', profile.degreeLevel);
    add('Field of study', profile.fieldOfStudy);
    add('State', profile.state);
    add('GPA', profile.gpa);
    add('Stage', profile.stage);
  }
  return lines;
}

/**
 * Assembles the copy-and-run prompt.
 *
 * Everything factual in it comes from the opportunity record or from the applicant's own profile.
 * This module adds no fact of its own, the rule fragments forbid the model from adding one either,
 * and the one place a value could be quietly manufactured — the template skeleton — is rendered
 * through the same `buildSlotContext` -> `fillTemplate` path the document uses, so an unknown slot
 * arrives as a visible `[TODO: …]` and never as plausible filler.
 *
 * It promises nothing about AI detection. The button that copies it says "includes AI-detection
 * avoidance" because the brief bars the constructions the cited research measured; the brief
 * itself says in its own words that it will not make a classifier report "human", and no wording
 * in this module may say otherwise.
 *
 * IT ALSO REPORTS WHAT IT PUT IN, and the enumeration is built HERE rather than beside the button,
 * at the same `if` that decides whether the section is written. A second list maintained elsewhere
 * is a list that drifts, and the drift is invisible: the screen says "your profile facts" and the
 * prompt has no such heading. `included` / `omitted` name the clauses the subtitle prints, so the
 * enumeration cannot describe a prompt this function did not compose.
 */
export function composePromptContents(ctx: PromptContext): PromptContents {
  const { program, profile, templateId, includeDisclosure } = ctx;
  const out: string[] = [];
  const included: string[] = [];
  const omitted: OmittedSection[] = [];

  out.push(`# Application drafting brief — ${program.name}`);
  out.push('');
  out.push(
    'You are helping me write part of a real grant application. Follow every rule in this brief. Where a rule and your defaults conflict, the rule wins.',
  );
  out.push('');

  out.push('## What this funder actually requires');
  out.push(`- Program: ${program.name}`);
  out.push(`- Kind of opportunity: ${CLASS_LABEL[program.klass]}`);
  if (program.summary.trim() !== '') out.push(`- In the record: ${program.summary.trim()}`);
  out.push(`- Who may apply: ${program.applicantEntities.map((e) => ENTITY_LABEL[e]).join(', ')}`);
  out.push(
    `- What is awarded: ${INSTRUMENT_LABEL[program.amount.instrument]}${
      program.amount.amountRaw.trim() === '' ? '' : ` — ${program.amount.amountRaw.trim()}`
    }`,
  );
  if (program.amount.awardCountRaw.trim() !== '') {
    out.push(`- Number of awards: ${program.amount.awardCountRaw.trim()}`);
  }
  out.push(...describeDeadline(program.deadline));
  const route = program.applyUrl ?? program.applyContact;
  out.push(`- How to apply: ${APPLY_VIA_LABEL[program.applyVia]}${route ? ` — ${route}` : ''}`);
  out.push(`- Record status: ${STATUS_LABEL[program.trust.status]}`);
  out.push(
    `- These facts came from ${program.trust.sourceUrl}, last verified ${program.trust.lastVerifiedAt}. Anything that matters to the application should be checked against that page.`,
  );
  if (program.trust.staleMirrorWarning) out.push(`- ${program.trust.staleMirrorWarning}`);
  out.push('');
  // Always present: the record itself is what this brief is built from.
  included.push('this funder’s published criteria');

  if (program.fundingRestrictions.length > 0) {
    out.push('### This funder will not fund');
    for (const r of program.fundingRestrictions) out.push(`- ${r}`);
    out.push('');
    included.push('what they will not fund, in their words');
  }

  const obligations = obligationLines(program);
  if (obligations.length > 0) {
    out.push('### Obligations attached to the award');
    out.push(...obligations);
    out.push('');
    included.push('the obligations attached to the award');
  }

  if (program.constraints.length > 0) {
    out.push('### Eligibility text, verbatim from the funder');
    for (const c of program.constraints) {
      out.push(`- ${c.hard ? 'Requirement' : 'Preference'}: ${c.rawText}`);
    }
    out.push('');
  }

  if (program.rawOtherText.trim() !== '') {
    out.push('### Other published requirements, verbatim');
    out.push(program.rawOtherText.trim());
    out.push('');
  }

  if (program.trust.disputed) {
    out.push('### Contested facts — two sources disagree, so assert neither');
    out.push(program.trust.disputed.note);
    for (const claim of program.trust.disputed.claims) out.push(`- ${claim.claim} (${claim.sourceUrl})`);
    out.push('');
  }

  out.push("## This funder's stated position on applicants using AI");
  if (program.aiPolicy.stance === 'unaddressed') {
    out.push(`${program.name} has not published a policy on applicants using AI.`);
    out.push(disclosureNote('unaddressed'));
    // The section is there and says the truthful thing; what is NOT there is a quote, because
    // there is nothing to quote. "their AI policy, quoted, with the source URL" would be a
    // sentence about a page this funder has never published.
    omitted.push({
      clause: 'their AI policy, quoted, with the source URL',
      reason: `${program.name} has published no position on applicants using AI — the brief says so instead`,
    });
  } else {
    out.push(disclosureNote(program.aiPolicy.stance));
    if (program.aiPolicy.quote) out.push('', `> ${program.aiPolicy.quote}`);
    if (program.aiPolicy.url) out.push('', `Source: ${program.aiPolicy.url}`);
    const quoted = Boolean(program.aiPolicy.quote);
    const sourced = Boolean(program.aiPolicy.url);
    included.push(
      quoted && sourced
        ? 'their AI policy, quoted, with the source URL'
        : quoted
          ? 'their AI policy, quoted'
          : 'their stated AI position',
    );
  }
  out.push('');

  const facts = profile === undefined ? [] : profileFacts(profile);
  if (facts.length > 0) {
    out.push('## Facts about me that you may use');
    out.push('These are the only facts you have about me. Do not add to them; ask me instead.');
    out.push('');
    out.push(...facts);
    out.push('');
    included.push(`your profile facts (${String(facts.length)})`);
  } else {
    omitted.push({
      clause: 'your profile facts',
      reason:
        profile === undefined
          ? 'you have no saved profile, so the brief carries no fact about you and the model is told to ask'
          : 'your profile has no filled-in field to carry, so the brief carries no fact about you and the model is told to ask',
    });
  }

  if (templateId !== undefined) {
    const template = getTemplate(templateId);
    const filled = fillTemplate(template.body.trim(), buildSlotContext({ profile, program }));
    out.push(`## The section I need: ${template.title}`);
    if (template.lengthTarget) out.push(`Target length: ${template.lengthTarget}`);
    out.push(
      'The skeleton below is already filled with the facts above. Every `[TODO: …]` marker is a hole only I can fill — keep it in the draft, word for word, until I have answered it.',
    );
    out.push('');
    out.push(filled.markdown);
    out.push('');
    if (filled.unresolvedSlots.length > 0) {
      out.push('Gaps in that skeleton, which are the first things to ask me for:');
      for (const path of filled.unresolvedSlots) {
        const def = slotDef(path);
        out.push(`- ${path}${def ? ` — ${def.label}: ${def.hint}` : ''}`);
      }
      out.push('');
    }
    included.push(`the “${template.title}” skeleton, with every unsupplied fact left as a gap`);
  }

  for (const id of FRAGMENT_ORDER) {
    out.push(loadFragment(id));
    out.push('');
  }
  /*
   * FRAGMENT_ORDER is not conditional — every one of these six is loaded from disk on every
   * compose, and `loadFragment` throws rather than returning empty if a file is missing, so a
   * clause here cannot outlive its fragment. They are enumerated in the order the brief presents
   * them, which is the order a reader checking the claim would find them in.
   */
  included.push(
    'an interview-first rule so the model asks before it drafts',
    'the specificity ruleset (named subjects, proper nouns, figures, dates)',
    'banned stock transitions, openers and closers',
    'a brevity pass',
    'a never-invent-a-citation rule',
  );

  if (includeDisclosure) {
    out.push('## AI-use disclosure');
    out.push(
      'Put this sentence at the end of the document, edited to match how I actually used you. If any clause of it is not true, change it or delete it — an inaccurate disclosure is worse than none.',
    );
    out.push('');
    out.push(`> ${disclosureSentence({ stance: program.aiPolicy.stance, funderName: program.name })}`);
    out.push('');
    included.push('an editable AI-use disclosure sentence');
  } else {
    omitted.push({
      clause: 'an editable AI-use disclosure sentence',
      reason: 'you switched it off — the funder’s own AI policy above is unaffected by that switch',
    });
  }

  out.push('## Before you hand the draft back');
  out.push(
    'End with the "Facts to verify" list. I will confirm every entry in it by hand before this document is exported or submitted; the funder holds me accountable for each one, not you.',
  );

  return { prompt: out.join('\n'), included, omitted };
}

/** The prompt alone, for the callers that only ever wanted the text. */
export function composePrompt(ctx: PromptContext): string {
  return composePromptContents(ctx).prompt;
}
