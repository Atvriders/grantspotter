import type { Funder, OrgProfile, Program, StudentProfile } from '@grantspotter/core';
import { describe, expect, it } from 'vitest';
import { fillTemplate, todoFor } from './fill.js';
import { getTemplate } from './load.js';
import {
  SLOT_VOCABULARY,
  buildSlotContext,
  describeSlotKnowledge,
  isKnownSlot,
  slotDef,
  userAnswerSlots,
} from './slots.js';

const ORG: OrgProfile = {
  kind: 'organization',
  entity: 'club_unincorporated',
  orgName: 'Example Collegiate Amateur Radio Club',
  callsign: 'W8UM',
  state: 'MI',
  memberCount: 34,
  institutionName: 'Example State University',
  arrlAffiliated: true,
};

const STUDENT: StudentProfile = {
  kind: 'student',
  callsign: 'KD9XYZ',
  licenseClass: 'GENERAL',
  licensedSince: '2023-04-11',
  institution: 'Example State University',
  degreeLevel: 'BACH',
  fieldOfStudy: 'Electrical Engineering',
  gpa: 3.4,
  state: 'MI',
};

const PROGRAM = {
  id: 'ardc-grants',
  funderId: 'ardc',
  name: 'ARDC Grants Program',
  klass: 'ham_grant',
  summary: 'Grants for amateur radio and digital communication.',
  applicantEntities: ['club_via_fiscal_sponsor', 'university'],
  amount: { instrument: 'cash_range', amountRaw: '$1,285-$258,000', awardCountRaw: 'Multiple per year' },
  deadline: { kind: 'n_fixed_dates', source: { kind: 'self' }, note: 'Feb 1, Apr 1, Jul 1, Sep 1' },
  applyVia: 'external_spa_portal',
  applyUrl: 'https://www.ardc.net/apply/',
  constraints: [],
  fundingRestrictions: [],
  obligations: { costShareRequired: false, coFunderPreference: false },
  aiPolicy: { stance: 'permitted' },
  trust: {
    status: 'open',
    sourceUrl: 'https://www.ardc.net/apply/',
    lastVerifiedAt: '2026-08-02',
    verificationMethod: 'live_fetch',
    contentHash: 'abc',
  },
  rawOtherText: '',
  tags: [],
} as unknown as Program;

const FUNDER: Funder = {
  id: 'ardc',
  name: 'Amateur Radio Digital Communications',
  homepage: 'https://www.ardc.net/',
};

/**
 * Every optional field of core's two profile shapes, populated. `Required<…>` is the point:
 * when core grows a profile field, this stops compiling, and the coverage tests below then
 * decide whether the new field deserves a slot. A profile-sourced slot that nothing maps is
 * invisible — it becomes a permanent `[TODO: …]` the applicant can never clear from their
 * profile, which is how an organisation's geography once became permanently unresolvable.
 *
 * `fieldSources` IS OMITTED, and the omission is that decision being made rather than dodged.
 * It arrived with core's profile provenance (`ProfileFieldSource`: which values this tool
 * fetched, when, and what it wrote) and it is provenance ABOUT the other fields, not a field an
 * applicant fills in — core names it in `PROFILE_NON_FIELD_KEYS` alongside the discriminant for
 * exactly that reason. A template slot for it would render a marker into an application
 * narrative, which is not a fact about the applicant. The tripwire fired as designed; this is
 * the answer to it.
 */
const MAXIMAL_ORG: Required<Omit<OrgProfile, 'fieldSources'>> = {
  kind: 'organization',
  entity: 'club_501c3',
  orgName: 'Example Collegiate Amateur Radio Club',
  callsign: 'W8UM',
  state: 'MI',
  lat: 42.28,
  lon: -83.74,
  ein: '00-0000000',
  is501c3: true,
  hasFiscalSponsor: false,
  arrlAffiliated: true,
  memberCount: 34,
  institutionName: 'Example State University',
};

/** Same omission, same reason: see MAXIMAL_ORG above. */
const MAXIMAL_STUDENT: Required<Omit<StudentProfile, 'fieldSources'>> = {
  kind: 'student',
  callsign: 'KD9XYZ',
  licenseClass: 'GENERAL',
  licensedSince: '2023-04-11',
  state: 'MI',
  county: 'Example County',
  lat: 42.28,
  lon: -83.74,
  callDistrict: '9',
  fieldOfStudy: 'Electrical Engineering',
  degreeLevel: 'BACH',
  institution: 'Example State University',
  accredited: true,
  partTime: false,
  gpa: 3.4,
  classRankTopPct: 10,
  arrlMemberSince: '2023-05-01',
  citizenship: 'US_CITIZEN',
  birthDate: '2006-02-14',
  stage: 'UNDERGRAD',
  activityKinds: ['club_member'],
  cwWpm: 15,
  financialNeed: true,
  gender: 'prefer_not_to_say',
};

/** Fully typed, so a shape change in core fails the build rather than the fixture cast. */
const MAXIMAL_PROGRAM: Program = {
  id: 'ardc-grants',
  funderId: 'ardc',
  name: 'ARDC Grants Program',
  klass: 'ham_grant',
  summary: 'Grants for amateur radio and digital communication.',
  applicantEntities: ['club_via_fiscal_sponsor', 'university'],
  amount: {
    instrument: 'cash_range',
    amountRaw: '$1,285-$258,000',
    awardCountRaw: 'Multiple per year',
  },
  deadline: { kind: 'n_fixed_dates', source: { kind: 'self' }, note: 'Feb 1, Apr 1, Jul 1, Sep 1' },
  applyVia: 'external_spa_portal',
  applyUrl: 'https://www.ardc.net/apply/',
  applyContact: 'grants@example.com',
  constraints: [],
  fundingRestrictions: [],
  obligations: { costShareRequired: false, coFunderPreference: false },
  aiPolicy: { stance: 'permitted' },
  trust: {
    status: 'open',
    sourceUrl: 'https://www.ardc.net/apply/',
    lastVerifiedAt: '2026-08-02',
    verificationMethod: 'live_fetch',
    contentHash: 'abc',
  },
  rawOtherText: '',
  tags: [],
};

describe('SLOT_VOCABULARY', () => {
  it('has unique dotted paths and a non-empty hint for every slot', () => {
    const paths = SLOT_VOCABULARY.map((s) => s.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const s of SLOT_VOCABULARY) {
      expect(s.path).toMatch(/^[a-z]+\.[A-Za-z][A-Za-z0-9]*$/);
      expect(s.hint.length).toBeGreaterThan(5);
      expect(s.label.length).toBeGreaterThan(2);
    }
  });

  it('exposes lookup helpers', () => {
    expect(isKnownSlot('club.callsign')).toBe(true);
    expect(isKnownSlot('club.notAThing')).toBe(false);
    expect(slotDef('club.callsign')?.source).toBe('profile');
    expect(userAnswerSlots().every((s) => s.source === 'user')).toBe(true);
    expect(userAnswerSlots().length).toBeGreaterThan(20);
  });

  /**
   * The hint is rendered INSIDE `[TODO: <path> — <hint>]` by Task 3's `todoFor`. A `]` would
   * end the marker early, a newline would split it across a markdown line, and `{{` would put
   * a second slot inside the hole left by the first.
   */
  /**
   * PINNED AGAINST A CROSS-TASK CONFLICT, on purpose.
   *
   * The plan itself specifies this exact rendering — "a writer who sees
   * `[TODO: club.callsign — your club's FCC callsign, e.g. W8UM]` knows exactly what to supply"
   * — and Task 3's `fillTemplate` test asserts that whole string byte-for-byte.
   *
   * Task 3's NEXT test then asserts the filled output matches no `\b[A-Z]{1,2}\d{1,2}[A-Z]{1,4}\b`
   * token, which `W8UM` and `KD9XYZ` both do. Those two tests cannot both pass, and the tempting
   * fix — delete the example from the hint — is the WRONG one: it satisfies a regex by making the
   * instruction vaguer, and the marker's whole job is to tell a writer what to supply. The right
   * fix is in Task 3: scope the "no plausible callsign" check to text OUTSIDE `[TODO: …]` markers,
   * since a marker is visibly an instruction and can never be mistaken for an asserted fact.
   * Reported in task-2-report.md. This test exists so the wrong fix turns something red.
   */
  it('keeps the illustrative callsign inside the callsign hints', () => {
    expect(slotDef('club.callsign')?.hint).toBe("your club's FCC callsign, e.g. W8UM");
    expect(slotDef('student.callsign')?.hint).toBe('your own callsign, e.g. KD9XYZ');
  });

  it('keeps every hint safe to render inside a [TODO: …] marker', () => {
    for (const s of SLOT_VOCABULARY) {
      expect(s.hint, `${s.path} hint`).not.toMatch(/[\]\n\r]/);
      expect(s.hint, `${s.path} hint`).not.toContain('{{');
      expect(s.label, `${s.path} label`).not.toMatch(/[\]\n\r]/);
    }
  });
});

describe('buildSlotContext', () => {
  it('maps an organization profile onto club.* slots', () => {
    const ctx = buildSlotContext({ profile: ORG });
    expect(ctx['club.name']).toBe('Example Collegiate Amateur Radio Club');
    expect(ctx['club.callsign']).toBe('W8UM');
    expect(ctx['club.memberCount']).toBe(34);
    expect(ctx['club.institution']).toBe('Example State University');
    expect(ctx['club.arrlAffiliated']).toBe('an ARRL-affiliated club');
    expect(ctx['club.ein']).toBeUndefined();
  });

  it('maps a student profile onto student.* slots', () => {
    const ctx = buildSlotContext({ profile: STUDENT });
    expect(ctx['student.callsign']).toBe('KD9XYZ');
    expect(ctx['student.licenseClass']).toBe('GENERAL');
    expect(ctx['student.gpa']).toBe(3.4);
    expect(ctx['club.name']).toBeUndefined();
  });

  it('maps program and funder facts onto funder.* slots', () => {
    const ctx = buildSlotContext({ program: PROGRAM, funder: FUNDER });
    expect(ctx['funder.programName']).toBe('ARDC Grants Program');
    expect(ctx['funder.name']).toBe('Amateur Radio Digital Communications');
    expect(ctx['funder.amountRaw']).toBe('$1,285-$258,000');
    expect(ctx['funder.deadlineNote']).toBe('Feb 1, Apr 1, Jul 1, Sep 1');
    expect(ctx['funder.applyUrl']).toBe('https://www.ardc.net/apply/');
  });

  it('lets answers override, ignores unknown answer keys, and ignores blank answers', () => {
    const ctx = buildSlotContext({
      profile: ORG,
      answers: { 'club.city': 'Ann Arbor', 'club.callsign': '', 'made.upKey': 'W1AW' },
    });
    expect(ctx['club.city']).toBe('Ann Arbor');
    expect(ctx['club.callsign']).toBe('W8UM');
    expect(ctx['made.upKey']).toBeUndefined();
  });

  /**
   * The builder's half of "explicit gaps, never plausible filler": a slot the applicant has to
   * answer must arrive at `fillTemplate` with NO value, so the template renders its `[TODO: …]`.
   * If the builder ever guesses a default for a `user` slot, the gap disappears and the guess
   * ships to a funder as though the applicant had written it.
   */
  it('never fills a user-answered slot from a profile or an opportunity record', () => {
    const ctx = buildSlotContext({
      profile: MAXIMAL_ORG,
      program: MAXIMAL_PROGRAM,
      funder: FUNDER,
    });
    const invented = Object.keys(ctx).filter((p) => slotDef(p)?.source === 'user');
    expect(invented).toEqual([]);
  });

  it('fills every profile-sourced club slot from a fully populated organization', () => {
    const ctx = buildSlotContext({ profile: MAXIMAL_ORG });
    const unmapped = SLOT_VOCABULARY.filter(
      (s) => s.source === 'profile' && s.path.startsWith('club.') && ctx[s.path] === undefined,
    ).map((s) => s.path);
    expect(unmapped).toEqual([]);
  });

  it('fills every profile-sourced student slot from a fully populated student', () => {
    const ctx = buildSlotContext({ profile: MAXIMAL_STUDENT });
    const unmapped = SLOT_VOCABULARY.filter(
      (s) => s.source === 'profile' && s.path.startsWith('student.') && ctx[s.path] === undefined,
    ).map((s) => s.path);
    expect(unmapped).toEqual([]);
  });

  it('fills every program-sourced slot from a fully populated program and funder', () => {
    const ctx = buildSlotContext({ program: MAXIMAL_PROGRAM, funder: FUNDER });
    const unmapped = SLOT_VOCABULARY.filter(
      (s) => s.source === 'program' && ctx[s.path] === undefined,
    ).map((s) => s.path);
    expect(unmapped).toEqual([]);
  });

  it('emits no key at all for an absent fact, rather than an empty string', () => {
    const ctx = buildSlotContext({ profile: { kind: 'organization', entity: 'club_unincorporated' } });
    expect(Object.hasOwn(ctx, 'club.name')).toBe(false);
    expect(Object.values(ctx).every((v) => v !== '' && v !== null && v !== undefined)).toBe(true);
  });

  it('says which side of a stated boolean the organization is on', () => {
    const plain = buildSlotContext({
      profile: { kind: 'organization', entity: 'club_unincorporated', arrlAffiliated: false },
    });
    expect(plain['club.arrlAffiliated']).toBe('not an ARRL-affiliated club');
    const silent = buildSlotContext({ profile: { kind: 'organization', entity: 'club_501c3' } });
    expect(silent['club.arrlAffiliated']).toBeUndefined();
  });
});

/**
 * THE THREE KNOWLEDGE STATES.
 *
 * `buildSlotContext` is a flat `Record<string, unknown>` because that is what `fillTemplate`
 * takes, and a flat record can only say "there is a value" or "there is not". That collapses two
 * genuinely different facts: an organisation that has not told us its EIN, and a student who
 * cannot have one because there is no organisation. Collapsing them is how a slot form asks a
 * high-school senior for their club's member count, and how a "just fill this in" prompt turns
 * into invented filler.
 *
 * Core already draws this distinction for funder facts — `Obligations.costShareRequired` is
 * documented as "`true` required · `false` the funder said it is not required · absent unstated"
 * — and 148 records once asserted "no cost share required" when no funder had said so. This is
 * the same three-way, on the applicant's side of the desk.
 */
describe('describeSlotKnowledge', () => {
  it('covers every slot in the vocabulary, exactly once', () => {
    const k = describeSlotKnowledge({ profile: ORG });
    expect(Object.keys(k).sort()).toEqual(SLOT_VOCABULARY.map((s) => s.path).sort());
  });

  it('reports a stated fact as known, with the origin that supplied it', () => {
    const k = describeSlotKnowledge({ profile: ORG, program: PROGRAM, funder: FUNDER });
    expect(k['club.callsign']).toEqual({ state: 'known', value: 'W8UM', origin: 'profile' });
    expect(k['funder.applyUrl']).toEqual({
      state: 'known',
      value: 'https://www.ardc.net/apply/',
      origin: 'program',
    });
    const answered = describeSlotKnowledge({ profile: ORG, answers: { 'club.city': 'Ann Arbor' } });
    expect(answered['club.city']).toEqual({ state: 'known', value: 'Ann Arbor', origin: 'answer' });
  });

  it('reports silence as unknown — never as an empty value', () => {
    const k = describeSlotKnowledge({ profile: ORG });
    expect(k['club.ein']).toEqual({ state: 'unknown' });
    expect(k['project.title']).toEqual({ state: 'unknown' });
    expect(k['funder.name']).toEqual({ state: 'unknown' });
  });

  it('marks the individual slots not applicable to an organization applicant', () => {
    const k = describeSlotKnowledge({ profile: ORG });
    for (const s of SLOT_VOCABULARY.filter((d) => d.path.startsWith('student.'))) {
      expect(k[s.path]?.state, s.path).toBe('not_applicable');
    }
    expect(k['club.name']?.state).toBe('known');
  });

  it('marks the applying-organization slots not applicable to an individual applicant', () => {
    const k = describeSlotKnowledge({ profile: STUDENT });
    for (const s of SLOT_VOCABULARY.filter((d) => d.path.startsWith('club.'))) {
      expect(k[s.path]?.state, s.path).toBe('not_applicable');
    }
    expect(k['student.gpa']?.state).toBe('known');
  });

  it('separates an unlicensed applicant from one who simply has not said', () => {
    const unlicensed = describeSlotKnowledge({
      profile: { kind: 'student', licenseClass: 'NONE' },
    });
    expect(unlicensed['student.callsign']?.state).toBe('not_applicable');
    expect(unlicensed['student.licensedSince']?.state).toBe('not_applicable');
    expect(unlicensed['student.licenseClass']).toEqual({
      state: 'known',
      value: 'NONE',
      origin: 'profile',
    });

    const silent = describeSlotKnowledge({ profile: { kind: 'student' } });
    expect(silent['student.callsign']).toEqual({ state: 'unknown' });
    expect(silent['student.licensedSince']).toEqual({ state: 'unknown' });
  });

  it('separates an organization that stated it has no fiscal sponsor from one that has not said', () => {
    const none = describeSlotKnowledge({
      profile: { kind: 'organization', entity: 'club_unincorporated', hasFiscalSponsor: false },
    });
    expect(none['club.fiscalSponsor']?.state).toBe('not_applicable');

    const yes = describeSlotKnowledge({
      profile: { kind: 'organization', entity: 'club_via_fiscal_sponsor', hasFiscalSponsor: true },
    });
    expect(yes['club.fiscalSponsor']).toEqual({ state: 'unknown' });
  });

  it('marks the application URL not applicable when the funder publishes no URL route', () => {
    const byPost: Program = {
      ...MAXIMAL_PROGRAM,
      applyVia: 'email_pdf_packet',
      applyUrl: undefined,
      applyContact: 'grants@example.com',
    };
    const k = describeSlotKnowledge({ program: byPost });
    expect(k['funder.applyUrl']?.state).toBe('not_applicable');
    expect(k['funder.applyContact']).toEqual({
      state: 'known',
      value: 'grants@example.com',
      origin: 'program',
    });

    const portalWithNoUrl: Program = { ...MAXIMAL_PROGRAM, applyUrl: undefined };
    expect(describeSlotKnowledge({ program: portalWithNoUrl })['funder.applyUrl']).toEqual({
      state: 'unknown',
    });
  });

  /** Absence of a profile is silence about the applicant, never a statement about them. */
  it('never calls a slot inapplicable when nobody has said who the applicant is', () => {
    const k = describeSlotKnowledge({});
    const asserted = Object.entries(k)
      .filter(([, v]) => v.state !== 'unknown')
      .map(([p]) => p);
    expect(asserted).toEqual([]);
  });

  it('gives every not_applicable a written reason a person can read', () => {
    for (const profile of [ORG, STUDENT] as const) {
      for (const [path, k] of Object.entries(describeSlotKnowledge({ profile }))) {
        if (k.state !== 'not_applicable') continue;
        expect(k.reason.trim().length, `${path} reason`).toBeGreaterThan(20);
      }
    }
  });

  /**
   * The applicant is the authority on their own situation. If they answer a slot we believed
   * inapplicable, the answer wins — dropping it would delete something a person deliberately
   * typed, which is the mirror image of inventing something they did not.
   */
  it('lets an explicit answer overrule an inapplicable slot', () => {
    const k = describeSlotKnowledge({
      profile: STUDENT,
      answers: { 'club.name': 'Example Collegiate Amateur Radio Club' },
    });
    expect(k['club.name']).toEqual({
      state: 'known',
      value: 'Example Collegiate Amateur Radio Club',
      origin: 'answer',
    });
    expect(k['club.callsign']?.state).toBe('not_applicable');
  });

  /**
   * `not_applicable` is advice for the slot form and the fact checklist, never a way to make a
   * hole disappear: it produces no context value, so `fillTemplate` still renders `[TODO: …]`
   * wherever a template actually uses the slot. The worst case of a wrong applicability call is
   * a misleading explanation, never a silently dropped fact.
   */
  it('is exactly the known half of the context, so an inapplicable slot still leaves a gap', () => {
    const input = {
      profile: ORG,
      program: PROGRAM,
      funder: FUNDER,
      answers: { 'club.city': 'Ann Arbor' },
    };
    const ctx = buildSlotContext(input);
    const knowledge = describeSlotKnowledge(input);
    const known = Object.entries(knowledge).filter(([, v]) => v.state === 'known');

    expect(Object.keys(ctx).sort()).toEqual(known.map(([p]) => p).sort());
    for (const [path, entry] of known) {
      expect(entry.state === 'known' && ctx[path]).toEqual(entry.state === 'known' && entry.value);
    }
    for (const [path, entry] of Object.entries(knowledge)) {
      if (entry.state === 'known') continue;
      expect(Object.hasOwn(ctx, path), `${path} must leave a gap`).toBe(false);
    }
  });
});

/**
 * TASK 6'S GAP, CLOSED.
 *
 * The thank-you letter and the interim/final report both had to say what a funder actually
 * awarded — which is not always what the applicant requested — and until this slot existed they
 * could only say so in prose ("copy the figure from the award letter"). Prose is invisible to
 * anything that walks `SLOT_VOCABULARY` or a template's derived `.slots`, so a checklist built on
 * that vocabulary could never surface either figure for confirmation. `project.awardAmount` is
 * that slot, and it never carries an origin of `profile` or `program`: nothing in either shape
 * states an award, only the award letter does, so it can only ever arrive as an `answer`.
 */
describe('project.awardAmount', () => {
  const IN_KIND_PROGRAM: Program = {
    ...MAXIMAL_PROGRAM,
    amount: {
      instrument: 'in_kind_equipment',
      amountRaw: 'one Icom IC-7300',
      awardCountRaw: 'Multiple per year',
    },
  };

  it('is a user-supplied sibling of project.requestAmount, not derivable from a profile or a program', () => {
    expect(slotDef('project.awardAmount')?.source).toBe('user');
    expect(slotDef('project.requestAmount')?.source).toBe('user');
    expect(slotDef('project.awardAmount')?.hint).toMatch(/award letter/);
  });

  it('is unknown before anyone has said what was awarded, even against a full profile and a cash program', () => {
    const k = describeSlotKnowledge({ profile: MAXIMAL_ORG, program: MAXIMAL_PROGRAM, funder: FUNDER });
    expect(k['project.awardAmount']).toEqual({ state: 'unknown' });
  });

  it('is never invented from a profile or an opportunity record — only buildSlotContext leaves it out', () => {
    const ctx = buildSlotContext({ profile: MAXIMAL_ORG, program: MAXIMAL_PROGRAM, funder: FUNDER });
    expect(ctx['project.awardAmount']).toBeUndefined();
  });

  it('becomes known, with origin "answer", once the applicant states it', () => {
    const k = describeSlotKnowledge({ answers: { 'project.awardAmount': '$3,000' } });
    expect(k['project.awardAmount']).toEqual({ state: 'known', value: '$3,000', origin: 'answer' });
  });

  it('is not_applicable when the opportunity record states a non-cash instrument', () => {
    const k = describeSlotKnowledge({ program: IN_KIND_PROGRAM });
    expect(k['project.awardAmount']?.state).toBe('not_applicable');
    const entry = k['project.awardAmount'];
    expect(entry.state === 'not_applicable' && entry.reason.length).toBeGreaterThan(20);
  });

  /**
   * The judgment call the task brief calls out directly: an award that has not been decided yet
   * is silence, not a stated fact ruling the slot out. Only a program that has told us, in its own
   * published record, that it never pays in dollars may move this to `not_applicable` — never the
   * mere absence of a decision.
   */
  it('stays unknown — never not_applicable — for a cash program or no program at all', () => {
    expect(describeSlotKnowledge({ program: MAXIMAL_PROGRAM })['project.awardAmount']).toEqual({
      state: 'unknown',
    });
    expect(describeSlotKnowledge({})['project.awardAmount']).toEqual({ state: 'unknown' });
  });

  it('lets an explicit answer overrule the non-cash not_applicable call, same as every other slot', () => {
    const k = describeSlotKnowledge({
      program: IN_KIND_PROGRAM,
      answers: { 'project.awardAmount': 'one Icom IC-7300' },
    });
    expect(k['project.awardAmount']).toEqual({
      state: 'known',
      value: 'one Icom IC-7300',
      origin: 'answer',
    });
  });

  it('resolves independently of project.requestAmount — the two never conflate', () => {
    const ctx = buildSlotContext({
      answers: { 'project.requestAmount': '$5,000', 'project.awardAmount': '$3,000' },
    });
    expect(ctx['project.requestAmount']).toBe('$5,000');
    expect(ctx['project.awardAmount']).toBe('$3,000');
  });

  /**
   * The acceptance bar for this whole task: a checklist that walks a template's derived `.slots`
   * (exactly what Task 14 does) must now find `project.awardAmount` in both templates, and the
   * report must keep `project.requestAmount` distinct rather than reusing it for the award.
   */
  it('is visible to a checklist walking each template\'s derived slot list', () => {
    const thankYou = getTemplate('thank-you-letter');
    const report = getTemplate('interim-final-report');
    expect(thankYou.slots).toContain('project.awardAmount');
    expect(report.slots).toContain('project.awardAmount');
    expect(report.slots).toContain('project.requestAmount');
  });

  it('renders as a [TODO: …] gap in both templates against an empty context', () => {
    for (const id of ['thank-you-letter', 'interim-final-report']) {
      const t = getTemplate(id);
      const { markdown, unresolvedSlots } = fillTemplate(t.body, {});
      expect(unresolvedSlots, id).toContain('project.awardAmount');
      expect(markdown, id).toContain(todoFor('project.awardAmount'));
    }
  });
});
