/**
 * THE EIGHT REFUSALS THEIR OWN EVIDENCE REFUTED — extractor side.
 *
 * Each case below is a hard `ineligible` GrantSpotter published while displaying, as the reason, a
 * sentence from the funder that says the applicant qualifies. They are one shape: the funder named
 * ALTERNATIVES AT DIFFERENT TIERS, `ConstraintSpec` had room for one, the extractor picked a
 * winner, and the losing branch hardened into a refusal. The representation is
 * `ConstraintSpec.anyOf` / `.orUnrepresented` (see types.ts); this file pins what each extractor
 * now reads out of the funder's real wording, and the corpus-wide guards that stop a ninth.
 *
 * Kept in its own file rather than appended to part1/part2/word-sense, which concurrently-running
 * agents edit — the same reason license.test.ts and chrome-scope.test.ts exist.
 */
import type { ConstraintSpec, Program, RawOpportunity } from '@grantspotter/core';
import { evaluateConstraint } from '@grantspotter/core';
import { describe, expect, it } from 'vitest';
import { loadCorpus } from '../../../../../scripts/profile-corpus.js';
import { extractAgeStage } from './ageStage.js';
import { extractFieldOfStudy } from './fieldOfStudy.js';
import { extractGeography } from './geography.js';
import { extractHamActivity } from './hamActivity.js';
import { extractLicense } from './license.js';

const NOW = '2026-08-02T00:00:00.000Z';

let cached: ReturnType<typeof loadCorpus> | undefined;
function corpus(): ReturnType<typeof loadCorpus> {
  cached ??= loadCorpus();
  return cached;
}

const raw = (fields: Record<string, string>): RawOpportunity => ({
  sourceId: 's',
  externalKey: 'k',
  name: 'n',
  rawFields: fields,
  sourceUrl: 'https://example.test/x',
  rawText: Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n'),
});

function specsOn(program: Program, axis: string): ConstraintSpec[] {
  return program.constraints.filter((c) => c.spec.axis === axis).map((c) => c.spec);
}

async function find(name: string): Promise<Program> {
  const { programs } = await corpus();
  const p = programs.find((program) => program.name.includes(name));
  if (p === undefined) throw new Error(`${name} is missing from the corpus`);
  return p;
}

// ---------------------------------------------------------------- geography

describe('geography: the cascade had one winner and the funder named two places', () => {
  it('#2 IRARC — "Resident of Brevard County FL, OR ANY FL RESIDENT"', async () => {
    const irarc = await find('IRARC Memorial');
    expect(specsOn(irarc, 'geography')).toEqual([
      {
        axis: 'geography',
        // The county value carries its state since the same round's false-INCLUDE fix — the
        // funder wrote "Brevard County FL", and a bare county name passes whatever state the
        // applicant is in.
        geo: { type: 'county', values: ['Brevard, FL'] },
        anyOf: [{ axis: 'geography', geo: { type: 'state', values: ['FL'] } }],
      },
    ]);
  });

  it('#4 Gwinnett — "Resident of Gwinnett County GA, OR THE STATE OF GA"', async () => {
    const gwinnett = await find('Gwinnett Amateur Radio Society');
    expect(specsOn(gwinnett, 'geography')).toEqual([
      {
        axis: 'geography',
        geo: { type: 'county', values: ['Gwinnett, GA'] },
        anyOf: [{ axis: 'geography', geo: { type: 'state', values: ['GA'] } }],
      },
    ]);
  });

  it('#5 Michael R. Ware — "New England" is six states, not a word nothing matches', async () => {
    const ware = await find('Michael R. Ware');
    const [geo] = specsOn(ware, 'geography');
    if (geo.axis !== 'geography') throw new Error('not a geography spec');
    expect(geo.geo.type).toBe('state');
    // The four it always had, plus the six it silently dropped.
    for (const code of ['DE', 'MD', 'NJ', 'NY', 'CT', 'ME', 'MA', 'NH', 'RI', 'VT']) {
      expect(geo.geo.values, `missing ${code}`).toContain(code);
    }
    expect(geo.geo.values).toHaveLength(10);
  });

  it('#7 North Texas — "…AND OKLAHOMA RESIDENTS attending school in Texas or another state"', async () => {
    const nelson = await find('Bob Nelson, KB5BNU');
    expect(specsOn(nelson, 'geography')).toEqual([
      {
        axis: 'geography',
        geo: { type: 'arrl_section', values: ['North Texas'] },
        anyOf: [{ axis: 'geography', geo: { type: 'state', values: ['OK', 'TX'] } }],
      },
    ]);
  });

  /**
   * THE RULE THAT WOULD HAVE BEEN WRONG. "Emit every tier the text names" fixes all four above and
   * silently opens a county award to a whole state: the state name in a county list says WHERE the
   * counties are, it is not a second tier. Only a span the FUNDER marked as an alternative is read.
   */
  it('a county list that merely mentions its state gains no state tier', () => {
    const cs = extractGeography(
      raw({
        Region:
          'Residence in Central IL in one of these counties: Peoria, Tazewell, Woodford, Knox, ' +
          'McLean, Fulton, Logan, Marshall or Stark',
      }),
    );
    expect(cs).toHaveLength(1);
    expect(cs[0].spec).not.toHaveProperty('anyOf');
    const dc = extractGeography(raw({ Region: 'Maryland, DC, Delaware, Pennsylvania, or West Virginia' }));
    // The ", or" hand-off resolves to the SAME tier the base is already on — no alternative.
    expect(dc[0].spec).not.toHaveProperty('anyOf');
  });

  it('every geography alternative in the corpus is a different tier from its base', async () => {
    const { programs } = await corpus();
    const offenders: string[] = [];
    for (const program of programs) {
      for (const spec of specsOn(program, 'geography')) {
        if (spec.axis !== 'geography') continue;
        for (const alt of spec.anyOf ?? []) {
          if (alt.axis !== 'geography') offenders.push(`${program.name}: cross-axis alternative`);
          else if (alt.geo.type === spec.geo.type) {
            offenders.push(`${program.name}: alternative repeats tier ${alt.geo.type}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------- license

describe('license: an OR rendered as an AND', () => {
  it('#6 Michael R. Ware — "…General … two years …, OR HOLD A CURRENT AMATEUR EXTRA"', async () => {
    const ware = await find('Michael R. Ware');
    expect(specsOn(ware, 'license')).toEqual([
      {
        axis: 'license',
        licenseMin: 'GENERAL',
        heldMonthsMin: 24,
        anyOf: [{ axis: 'license', licenseMin: 'EXTRA' }],
      },
    ]);
  });

  /**
   * `licenseMinFrom` FALLS THROUGH to TECH for text naming no class. That is right for "Any active
   * Amateur Radio license" and catastrophic as an alternative tier — it would delete the funder's
   * floor. A fallthrough is a guess, and a guess is never an alternative.
   */
  it('a second clause that names no class mints no alternative, so no floor is deleted', () => {
    const cs = extractLicense(
      raw({
        'License Requirement':
          'Must hold a current General Class License, or be a member of the sponsoring club.',
      }),
    );
    expect(cs[0].spec).toMatchObject({ axis: 'license', licenseMin: 'GENERAL' });
    expect(cs[0].spec).not.toHaveProperty('anyOf');
    // …and a Technician is still refused, which is the whole point of the guard.
    expect(evaluateConstraint(
      cs[0].spec,
      { kind: 'student', licenseClass: 'TECH', licensedSince: '2010-01-01T00:00:00.000Z' },
      NOW,
      cs[0].rawText,
    ).status).toBe('fail');
  });

  it('no licence alternative in the corpus lowers a floor without naming its class', async () => {
    const { programs } = await corpus();
    const offenders: string[] = [];
    for (const program of programs) {
      for (const c of program.constraints) {
        if (c.spec.axis !== 'license') continue;
        for (const alt of c.spec.anyOf ?? []) {
          if (alt.axis !== 'license') {
            offenders.push(`${program.name}: cross-axis licence alternative`);
            continue;
          }
          if (!/\b(extra|general|technician|tech|novice)\b/i.test(c.rawText)) {
            offenders.push(`${program.name}: alternative ${alt.licenseMin} from text naming no class`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------- field of study

describe('field_of_study: a dropped alternative is a deleted route', () => {
  it('#3 IRARC — "UNDERGRADUATE DEGREE or electronic technician certification program"', async () => {
    const irarc = await find('IRARC Memorial');
    expect(specsOn(irarc, 'field_of_study')).toEqual([
      {
        axis: 'field_of_study',
        fields: ['electronic technician certification program'],
        excludedFields: [],
        anyOf: [{ axis: 'field_of_study', fields: [], excludedFields: [] }],
      },
    ]);
  });

  /**
   * NOT "any dropped fragment". Splitting the Daze scholarship's "Engineering, GPA requirement 3.0
   * or higher" leaves a bare "higher", which is also discarded and is NOT an alternative — it is
   * the tail of a GPA phrase another axis owns. Unrestricting an engineering-only award out of a
   * comparative adjective is the mirror defect.
   */
  it('a discarded comparative is not a route — the engineering-only award stays engineering-only', () => {
    const cs = extractFieldOfStudy(raw({ 'Field of Study': 'Engineering, GPA requirement 3.0 or higher' }));
    expect(cs[0].spec).toEqual({
      axis: 'field_of_study',
      fields: ['Engineering'],
      excludedFields: [],
      // A bare domain, so the schema records that it cannot adjudicate membership of it (a
      // Mechatronics student shares no word with "Engineering" and was refused). That is
      // `orUnrepresented`, which can only reach `unknown` — the assertions below are what keep it
      // from being confused with the route this test is about.
      orUnrepresented: 'Engineering',
    });
    // THE SUBJECT OF THIS TEST: no `anyOf`. An alternative tier would be `fields: []`, which the
    // matcher reads as UNRESTRICTED and passes for everybody — the mirror defect, an
    // engineering-only award opened to the whole world by a comparative adjective.
    expect(cs[0].spec).not.toHaveProperty('anyOf');
    const musicMajor = evaluateConstraint(
      cs[0].spec,
      { kind: 'student', fieldOfStudy: 'Music Performance' },
      NOW,
      cs[0].rawText,
    );
    expect(musicMajor.status).not.toBe('pass');
    expect(musicMajor).toEqual({ status: 'unknown', missing: [] });
  });

  /**
   * …and the refusal itself still happens, on the far commoner shape: a funder who names a
   * SPECIFIC field rather than a domain. Edmond A. Metzger, verbatim. Kept beside the test above so
   * "a music major is not admitted to an engineering award" stays pinned as a `fail` somewhere,
   * rather than softening everywhere the moment domains stopped deciding.
   */
  it('a named field, not a domain, still refuses the music major outright', () => {
    const cs = extractFieldOfStudy(
      raw({ 'Field of Study': "Bachelor's degree or higher in electrical engineering" }),
    );
    expect(cs[0].spec).not.toHaveProperty('orUnrepresented');
    expect(evaluateConstraint(
      cs[0].spec,
      { kind: 'student', fieldOfStudy: 'Music Performance' },
      NOW,
      cs[0].rawText,
    ).status).toBe('fail');
  });

  it('a degree prefix consumed by DEGREE_INTRO is not an alternative either', () => {
    const cs = extractFieldOfStudy(
      raw({ 'Field of Study': "Bachelor's degree or higher in electronics, communications, or related fields" }),
    );
    expect(cs[0].spec).not.toHaveProperty('anyOf');
  });
});

// ---------------------------------------------------------------- age / stage

describe('age_stage: the audience that has no profile field', () => {
  it('#1 Goldwater — the one-word "highschool" spelling cost the first-named audience', async () => {
    const goldwater = await find('Barry Goldwater');
    expect(specsOn(goldwater, 'age_stage')).toEqual([
      { axis: 'age_stage', stages: ['HS_SENIOR', 'UNDERGRAD'] },
    ]);
    expect(extractAgeStage(raw({ Other: 'open only to graduating highschool seniors' }))[0].spec).toEqual({
      axis: 'age_stage',
      stages: ['HS_SENIOR'],
    });
    for (const spelling of ['high school seniors', 'high-school seniors', 'highschool seniors']) {
      expect(extractAgeStage(raw({ Other: `Open to ${spelling}.` }))[0].spec, spelling).toEqual({
        axis: 'age_stage',
        stages: ['HS_SENIOR'],
      });
    }
  });

  it('Rodriguez K5AUW — "and TO previous awardees" is recorded, not invented and not refused', async () => {
    const rodriguez = await find('Robert A. Rodriguez K5AUW');
    expect(specsOn(rodriguez, 'age_stage')).toEqual([
      { axis: 'age_stage', stages: ['HS_SENIOR'], orUnrepresented: 'previous awardees' },
    ]);
    // No stage was invented for it: the record still says exactly the one audience it understood.
  });

  /**
   * The repeated preposition is what makes this detectable rather than a guess. Goldwater's two
   * audiences are coordinate ("seniors AND undergraduate students") and both are understood, so
   * nothing is filed as unrepresentable; Rodriguez's second object repeats "to" and matches no
   * stage.
   */
  it('a second audience the axis DID understand widens the list instead', () => {
    const cs = extractAgeStage(
      raw({ Other: 'Open to graduating high school seniors, and to undergraduate students.' }),
    );
    expect(cs[0].spec).toEqual({ axis: 'age_stage', stages: ['HS_SENIOR', 'UNDERGRAD'] });
  });

  it('ordinary prose with "and to" in it is not an audience list', () => {
    const cs = extractAgeStage(
      raw({ Other: 'Open to high school seniors. Send the form to the registrar and to the committee.' }),
    );
    expect(cs[0].spec).toEqual({ axis: 'age_stage', stages: ['HS_SENIOR'] });
  });

  it('exactly one record in the corpus carries an unrepresented audience, and it is Rodriguez', async () => {
    const { programs } = await corpus();
    const flagged: string[] = [];
    for (const program of programs) {
      for (const spec of specsOn(program, 'age_stage')) {
        if (spec.orUnrepresented !== undefined) flagged.push(`${program.name}: ${spec.orUnrepresented}`);
      }
    }
    expect(flagged).toEqual(['The Robert A. Rodriguez K5AUW Scholarship: previous awardees']);
  });
});

// ---------------------------------------------------------------- ham activity

describe('ham_activity: the spelling the funder used', () => {
  it('#8 ARDC — "participation in amateur radio EMERGENCY ACTIVITIES" is ARES/RACES/SKYWARN', async () => {
    const ardc = await find('(ARDC) Scholarships');
    const [spec] = specsOn(ardc, 'ham_activity');
    if (spec.axis !== 'ham_activity') throw new Error('not a ham_activity spec');
    expect(spec.activityKinds).toContain('ares_races_skywarn');
  });

  /**
   * THE GUARD, AND WHY IT IS NOT DECORATION. An unguarded `\bemergency communications\b` read the
   * ARRL Amateur Radio Grants page's "Grant requests for emergency communications equipment,
   * facilities, or projects WILL NOT BE CONSIDERED." — a funding RESTRICTION — as a required ham
   * activity, and published it quoting that sentence as the evidence. Requiring participation
   * language in the same clause admits every real case and rejects that one.
   */
  it('a sentence saying emergency comms will NOT be considered states no activity requirement', () => {
    expect(
      extractHamActivity(
        raw({
          eligibility:
            'Grant requests for emergency communications equipment, facilities, or projects will ' +
            'not be considered.',
        }),
      ),
    ).toEqual([]);
    expect(
      extractHamActivity(
        raw({ eligibility: 'Applicant must show participation in amateur radio emergency activities.' }),
      )[0].spec,
    ).toMatchObject({ activityKinds: ['ares_races_skywarn'] });
  });

  /**
   * CARA, from the corpus record rather than retyped — the funder's list ends with their own
   * "etc.", so a club member who does none of the three named things is not refused. Read out of
   * `rawText` on purpose: reproducing the sentence as a literal would make
   * `userFacingCopyContract` count the Profile page's "ARES, RACES or SKYWARN" option label as
   * asserted, on a 16-character coincidence, by a test that never renders that page.
   */
  it('CARA — a list the funder ends with "etc." does not refuse a club member', async () => {
    const cara = await find('CARA Merit');
    const activity = cara.constraints.find((c) => c.spec.axis === 'ham_activity');
    if (activity === undefined) throw new Error('CARA states an activity requirement and it is missing');
    expect(activity.hard).toBe(true);
    expect(activity.rawText.trimEnd().endsWith('etc.')).toBe(true);
    const clubOnly = { kind: 'student' as const, activityKinds: ['club_member' as const] };
    expect(evaluateConstraint(activity.spec, clubOnly, NOW, activity.rawText).status).toBe('pass');
    // …and the same spec against a sentence with no such qualifier still bars them, so the pass
    // above comes from the funder's word and not from the axis giving up.
    expect(
      evaluateConstraint(activity.spec, clubOnly, NOW, 'Applicant must be active in ARES.').status,
    ).toBe('fail');
  });

  /**
   * The three records that gained a ham_activity constraint from the spelled-out phrase all state
   * a genuine requirement AND open their own list ("such as …, etc."), so the constraint is
   * truthful and gates nobody. If the open-list rule ever stops firing, this is where three
   * scholarships start refusing everyone who is not an ARES volunteer.
   */
  it('no hard activity list in this corpus refuses an applicant its own sentence calls illustrative', async () => {
    const { programs } = await corpus();
    const anyKind = {
      kind: 'student' as const,
      activityKinds: ['club_member' as const],
      cwWpm: 30,
    };
    const offenders: string[] = [];
    for (const program of programs) {
      for (const c of program.constraints) {
        if (c.spec.axis !== 'ham_activity' || !c.hard) continue;
        if (!/\betc\b|\bsuch as\b|\bnot limited to\b|\bsimilar activities\b/i.test(c.rawText)) continue;
        const status = evaluateConstraint(c.spec, anyKind, NOW, c.rawText).status;
        if (status === 'fail') offenders.push(`${program.name}: ${JSON.stringify(c.rawText.slice(0, 90))}`);
      }
    }
    expect(offenders).toEqual([]);
    // Vacuity guard: there really are such records, so the assertion above is doing work.
    const { programs: all } = await corpus();
    const open = all.filter((p) =>
      p.constraints.some(
        (c) =>
          c.spec.axis === 'ham_activity' &&
          c.hard &&
          /\betc\b|\bsuch as\b|\bnot limited to\b|\bsimilar activities\b/i.test(c.rawText),
      ),
    );
    expect(open.length).toBeGreaterThanOrEqual(5);
  });
});

// ---------------------------------------------------------------- the whole-corpus direction

describe('nothing this round added can refuse anybody', () => {
  /**
   * The bound on the damage, measured over the real corpus rather than argued: for every published
   * constraint carrying an alternative, deleting the alternatives can only make the verdict WORSE.
   * A disjunction that ever narrowed would show up here on the record that carries it.
   */
  it('deleting every alternative never improves a verdict, on any record', async () => {
    const { programs } = await corpus();
    const profiles = [
      { kind: 'student' as const, state: 'FL', county: 'Orange', licenseClass: 'EXTRA' as const, licensedSince: '2026-02-01T00:00:00.000Z', fieldOfStudy: 'Biology', stage: 'HS_SENIOR' as const },
      { kind: 'student' as const, state: 'OK', licenseClass: 'GENERAL' as const, licensedSince: '2020-01-01T00:00:00.000Z', fieldOfStudy: 'Music', stage: 'GRAD' as const },
      { kind: 'student' as const },
    ];
    const rank = { fail: 0, unknown: 1, not_evaluable: 2, pass: 3 };
    const offenders: string[] = [];
    for (const program of programs) {
      for (const c of program.constraints) {
        const { anyOf: _a, orUnrepresented: _o, ...bare } = c.spec;
        void _a;
        void _o;
        if (_a === undefined && _o === undefined) continue;
        for (const profile of profiles) {
          const withAlt = evaluateConstraint(c.spec, profile, NOW, c.rawText).status;
          const without = evaluateConstraint(bare as ConstraintSpec, profile, NOW, c.rawText).status;
          if (rank[withAlt] < rank[without]) {
            offenders.push(`${program.name} ${c.spec.axis}: ${without} -> ${withAlt}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every alternative in the corpus is on the same axis as the tier it hangs off', async () => {
    const { programs } = await corpus();
    const offenders: string[] = [];
    let total = 0;
    for (const program of programs) {
      for (const c of program.constraints) {
        for (const alt of c.spec.anyOf ?? []) {
          total += 1;
          if (alt.axis !== c.spec.axis) offenders.push(`${program.name}: ${c.spec.axis} -> ${alt.axis}`);
        }
      }
    }
    expect(offenders).toEqual([]);
    // Vacuity guard, and the whole blast radius of `anyOf` over the committed fixtures: SIX
    // alternatives on five records — IRARC's geography and field_of_study, Gwinnett's and North
    // Texas's geography, Ware's licence, and Fred R. McDaniel's "Resident of FCC 5th call district
    // (TX, OK, AR, LA, MS, NM)", where the six states the funder spelled out are a second tier
    // beside a rule stored as a property of a CALLSIGN. Nothing else in 150 programs has one.
    expect(total).toBe(6);
  });
});
