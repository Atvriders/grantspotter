// `hamActivity.ts` only — the axis whose spec is an ALLOW-list, so anything matched off the page
// becomes a hard bar and anything missed is a silent exclusion.
//
// THE DEFECT THIS FILE PINS. `candidateTexts` falls back to `raw.rawText`, which for a source that
// files no `Other`/`eligibility` field is the WHOLE FLATTENED PAGE. Thirteen hard constraints in
// this corpus were read off site chrome, eight of them on this axis, and the clearest was YLRL:
// the Young Ladies Radio League's three scholarships are for licensed FEMALE hams, and the corpus
// demanded `contesting` of them because ylrl.net's menu bar reads "Contests/Certificates ·
// Contests · Contest Submission". Removing that one fabricated constraint is what flips the
// programme from `ineligible` to `eligible` for the two licensed female profiles the awards exist
// to fund. A product that hides a women-only ham scholarship from licensed women because of a
// nav link is worse than one that shows nothing.
//
// The assertions below run the REAL committed captures through the REAL pipeline; the unit checks
// beside them use verbatim strings from those same pages, so a detector that silently stops
// matching fails rather than passing vacuously.
//
// Kept in its own file rather than appended to part1.test.ts / part2.test.ts, which
// concurrently-running agents edit for other axes — the same reason license.test.ts,
// fieldOfStudy.test.ts, clause-split.test.ts and preference-scope.test.ts exist.
import type { ActivityKind, Program, RawOpportunity, StudentProfile } from '@grantspotter/core';
import { matchProgram } from '@grantspotter/core';
import { beforeAll, describe, expect, it } from 'vitest';
// The offline corpus loader: every committed REAL capture, parsed by its own source module and
// normalized exactly as the crawler does, minus the records the review queue suppresses. Shared
// with `scripts/profile-corpus.ts` and `normalize/licenseFloorContract.test.ts` rather than
// reimplemented, so no two audits can disagree about what "the corpus" is.
import { loadCorpus } from '../../../../../scripts/profile-corpus.js';
import { extractHamActivity, withoutSiteChrome } from './hamActivity.js';

const NOW = '2026-08-02T00:00:00.000Z';

let cached: ReturnType<typeof loadCorpus> | undefined;
function corpus(): ReturnType<typeof loadCorpus> {
  cached ??= loadCorpus();
  return cached;
}

/**
 * THE FIXTURE LOAD IS SETUP FOR THE WHOLE FILE, NOT PART OF ANY TEST'S TIME BUDGET. `loadCorpus`
 * re-parses every committed fixture — MEASURED at 2,374 ms on two cores on 2026-08-12 — and
 * without this hook that cost was charged to whichever `it` reached the corpus first, inside its
 * 5,000 ms default. `axes/spec-vs-sentence.test.ts` carries the measurement and the argument for
 * why the answer is a hook rather than a larger `testTimeout`; it is the file that went red first,
 * and every file in this list was sitting at about half the budget behind it.
 */
beforeAll(async () => {
  await corpus();
}, 120_000);

function keyOf(program: Program): string {
  const tag = (prefix: string): string =>
    program.tags.find((t) => t.startsWith(prefix))?.slice(prefix.length) ?? '?';
  return `${tag('source:')}::${tag('key:')}`;
}

/** A `for` loop, not `.filter().map()`: only the `continue` narrows `ConstraintSpec` to this axis. */
function activityOf(
  program: Program,
): Array<{ hard: boolean; kinds: readonly ActivityKind[]; rawText: string }> {
  const out: Array<{ hard: boolean; kinds: readonly ActivityKind[]; rawText: string }> = [];
  for (const c of program.constraints) {
    if (c.spec.axis !== 'ham_activity') continue;
    out.push({ hard: c.hard, kinds: c.spec.activityKinds, rawText: c.rawText });
  }
  return out;
}

const raw = (fields: Record<string, string>, rawText?: string): RawOpportunity => ({
  sourceId: 's',
  externalKey: 'k',
  name: 'n',
  rawFields: fields,
  sourceUrl: 'https://example.test/x',
  rawText: rawText ?? Object.values(fields).join('\n'),
});

/**
 * A licensed female student. Both real profiles YLRL's awards are aimed at — the EE undergraduate
 * (General class) and the certificate/trade student (Technician) — differ from this only in the
 * fields YLRL does not constrain.
 */
const licensedFemale: StudentProfile = {
  kind: 'student',
  callsign: 'K5EXAMPLE',
  licenseClass: 'GENERAL',
  licensedSince: '2022-06-01T00:00:00.000Z',
  state: 'TX',
  callDistrict: '5',
  fieldOfStudy: 'Electrical Engineering',
  degreeLevel: 'BACH',
  institution: 'A State University',
  accredited: true,
  partTime: false,
  gpa: 3.6,
  citizenship: 'US_CITIZEN',
  birthDate: '2006-03-01T00:00:00.000Z',
  stage: 'UNDERGRAD',
  activityKinds: ['club_member', 'on_air'],
  gender: 'female',
};

// ---------------------------------------------------------------- the mechanism

describe('site chrome is not eligibility text', () => {
  it('drops a real navigation run and keeps the sentence underneath it', () => {
    // Verbatim from fixtures/arrl-club-grant/ — the arrl.org masthead, followed by the page's
    // first real sentence. `splitClauses` cannot separate them: the nav carries no "." at all, so
    // the whole menu and the sentence come out as ONE clause.
    const page = [
      'Club Grant Program',
      'ARRL',
      'Website Search',
      'Category',
      'Clubs',
      'Contests',
      'Exam Sessions',
      'Hamfest/Conventions',
      'Licensing Classes',
      'Member Directory',
      'On The Air',
      'Public Service',
      'The ARRL Foundation is pleased to report that 37 Amateur Radio Clubs benefitted from grants.',
    ].join('\n');
    expect(withoutSiteChrome(page)).toBe(
      'The ARRL Foundation is pleased to report that 37 Amateur Radio Clubs benefitted from grants.',
    );
  });

  it('needs a RUN, so a lone label-shaped field value is never removed', () => {
    // The ARRL catalogue's flattened record. "Region: Any" and "Other: Must be a member of ARRL"
    // carry no "." either; they survive because they are labelled and because nothing like them
    // stands four deep. A rule without the run requirement would eat the funder's own answers.
    const record = [
      'Award Amount: $2,000',
      'License Requirement: None',
      'Region: Residence in GA.',
      'Field of Study: Engineering or Computer Science.',
      'Institution: Any',
      'Other: Must be a member of ARRL',
    ].join('\n');
    expect(withoutSiteChrome(record)).toBe(record);
    // And a short prose line stands on its own, however few words it has.
    expect(withoutSiteChrome('Any\nNone\nEngineering')).toBe('Any\nNone\nEngineering');
  });

  it('reads the requirement out of a page whose menu names every activity kind', () => {
    // The whole defect in one input: menu first, funder's actual bullet last.
    const page = [
      'Scholarships - Young Ladies Radio League',
      'Skip to content',
      'Contests/Certificates',
      'Contests',
      'Contest Submission',
      'Districts',
      'Youth',
      '• Applicant must be female.',
      '• Applicant must have an Amateur Radio License.',
    ].join('\n');
    expect(extractHamActivity(raw({}, page))).toEqual([]);
    // …and the guard is not a blanket "ignore rawText": a real requirement in the same position
    // still produces its constraint.
    const withRequirement = `${page}\n• Applicant must show proof of on-the-air activity.`;
    const cs = extractHamActivity(raw({}, withRequirement));
    expect(cs).toHaveLength(1);
    expect(cs[0].spec).toMatchObject({ activityKinds: ['on_air'], proofRequired: true });
    expect(cs[0].rawText).toBe('• Applicant must show proof of on-the-air activity.');
  });
});

// ---------------------------------------------------------------- the real captures

describe("YLRL's three scholarships, from the real capture", () => {
  const NAMED = [
    'ylrl::ylrl-ethel-smith-k4lmb',
    'ylrl::ylrl-mary-lou-brown-nm7n',
    'ylrl::ylrl-marte-wessel-k0epe',
  ];

  it('states EXACTLY the two bullets the funder publishes, and nothing about contesting', async () => {
    const { programs } = await corpus();
    const found = NAMED.map((key) => {
      const p = programs.find((program) => keyOf(program) === key);
      if (p === undefined) throw new Error(`${key} is missing from the corpus`);
      return p;
    });
    for (const program of found) {
      expect(
        program.constraints.map((c) => ({
          axis: c.spec.axis,
          hard: c.hard,
          spec: c.spec,
          rawText: c.rawText,
        })),
        program.name,
      ).toEqual([
        {
          axis: 'license',
          hard: true,
          spec: { axis: 'license', licenseMin: 'TECH' },
          rawText: 'Applicant must have an Amateur Radio License.',
        },
        {
          axis: 'gender',
          hard: true,
          spec: { axis: 'gender', allowed: ['female'] },
          rawText: 'Applicant must be female.',
        },
      ]);
    }
  });

  it('reaches a licensed female applicant — all three, plus the page-level record', async () => {
    const { programs } = await corpus();
    const ylrl = programs.filter((p) => keyOf(p).startsWith('ylrl::'));
    // Three named awards plus the "YLRL Scholarships" page record: the one that carried the
    // nav-derived `contesting` bar and was `ineligible` for every licensed female profile.
    expect(ylrl.map((p) => p.name).sort()).toEqual([
      'Ethel Smith K4LMB Memorial Scholarship',
      'Marte Wessel K0EPE Memorial Scholarship',
      'Mary Lou Brown NM7N Memorial Scholarship',
      'YLRL Scholarships',
    ]);
    for (const program of ylrl) {
      expect(matchProgram(licensedFemale, program, NOW).kind, program.name).toBe('eligible');
      expect(activityOf(program), program.name).toEqual([]);
    }
  });
});

describe('no ham-activity bar in this corpus is read off site chrome', () => {
  /**
   * The corpus-wide form of the same claim, and the one that fails if the guard is deleted: every
   * published `ham_activity` rawText must survive `withoutSiteChrome` unchanged. A nav run inside
   * a constraint's own quoted evidence is the defect, by definition.
   */
  it('every published ham_activity rawText is text a human wrote about eligibility', async () => {
    const { programs } = await corpus();
    const offenders: string[] = [];
    for (const program of programs) {
      for (const c of activityOf(program)) {
        if (withoutSiteChrome(c.rawText) !== c.rawText) {
          offenders.push(`${keyOf(program)} (${program.name}): ${JSON.stringify(c.rawText.slice(0, 120))}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * Vacuity guard. The assertion above passes trivially over an empty set, and this axis really
   * does have real constraints to protect — the ARDC list, CARA, CWops, MARCO, York, MMARSI,
   * YASME. If the guard ever over-reaches and starts eating funder text, this collapses.
   */
  it('still finds the real activity requirements it must not eat', async () => {
    const { programs } = await corpus();
    const withActivity = programs.filter((p) => activityOf(p).length > 0);
    expect(withActivity.length).toBeGreaterThanOrEqual(8);
    const ardc = programs.find(
      (p) => keyOf(p) === 'arrl-scholarship-descriptions::The Amateur Radio Digital Communications (ARDC) Scholarships',
    );
    if (ardc === undefined) throw new Error('the ARDC scholarships are missing from the corpus');
    // The largest programme in the corpus, and the one whose allow-list two rounds have now had to
    // widen: club membership and on-the-air activity are EXAMPLES of acceptable proof, so an
    // applicant holding either qualifies. Losing a spelling here excludes exactly the person the
    // funder's sentence describes.
    //
    // `ares_races_skywarn` is the spelling round six added, and it is derived from the sentence
    // rather than typed in: the funder's list says "participation in amateur radio EMERGENCY
    // ACTIVITIES" and names no acronym, so an ARES/RACES/SKYWARN volunteer was refused by a list
    // that describes exactly what they do. The assertion checks the sentence AND the kinds
    // together, so a future round that drops the spelling — or a fixture whose wording moves —
    // fails here instead of quietly certifying a narrower list.
    expect(activityOf(ardc)[0].rawText).toMatch(
      /participation in amateur radio emergency activities/i,
    );
    expect(activityOf(ardc)[0].kinds).toEqual([
      'club_member',
      'ares_races_skywarn',
      'teaching',
      'on_air',
    ]);
  });

  /**
   * The eight programmes B4 named, pinned by name and outcome.
   */
  it('pins the eight programmes whose activity kinds came off a menu', async () => {
    const { programs } = await corpus();
    const kindsFor = (key: string): unknown => {
      const p = programs.find((program) => keyOf(program) === key);
      if (p === undefined) throw new Error(`${key} is missing from the corpus`);
      return activityOf(p).map((c) => c.kinds);
    };
    // Gone: every kind these five carried came from the arrl.org / ieee.org / ylrl.net menus.
    expect(kindsFor('arrl-amateur-radio-grants::amateur-radio-grants')).toEqual([]);
    expect(kindsFor('arrl-club-grant::club-grant-program')).toEqual([]);
    expect(kindsFor('arrl-scholarship-program::scholarship-program')).toEqual([]);
    expect(kindsFor('ieee-student-branch-rebate::ieee-student-branch-rebate')).toEqual([]);
    expect(kindsFor('ylrl::ylrl-scholarships')).toEqual([]);
    // …and the three that survived the menu rule with a kind read from page PROSE. That remainder
    // was a second defect — prose that MENTIONS an activity without requiring it of the applicant —
    // and `eligibilityTexts` is the fix for it. Austin ARC loses its bar entirely (see below);
    // arrl.org's mega-footer link "Public Service Resources / Public Service Honor Roll" stops
    // being an ETP requirement.
    expect(kindsFor('arrl-etp-grants::etp-grants')).toEqual([['teaching']]);
    expect(kindsFor('austin-arc::austin-arc-scholarships')).toEqual([]);
    // The ARRL Foundation Special Funds' `club_member` was the one this test recorded as "org-
    // facing and tracked, not fixed here": its clause is "GROUPS THAT QUALIFY for mini-grants will
    // include, but not be limited to, … make a special effort to get them involved in CLUB
    // ACTIVITIES", a rule about GROUPS that only an individual could ever fail, and a student whose
    // activities are ARES/RACES and Field Day was ineligible on it. Now dropped by
    // `ORGANISATION_SUBJECT`.
    expect(kindsFor('arrl-foundation-special-funds::foundation-special-funds')).toEqual([]);
  });
});

// ---------------------------------------------------------------- provenance

/**
 * AUSTIN ARC vs ARDC — the pair that defeated the previous round.
 *
 * Both texts are comma-separated lists with no modal verb in them, so no rule about the WORDING
 * separates them. They differ in where they came from: ARDC's is the value of the ARRL catalogue's
 * `Other:` field, which by construction holds what the funder requires; Austin ARC's is the hero
 * strapline of a page that files no eligibility field at all, reached only through
 * `candidateTexts`' last-resort fallback to the whole flattened page.
 */
describe('an unlabelled page is not an eligibility field', () => {
  it('Austin ARC states its counties and asks for references — and bars nobody on activity', async () => {
    const { programs } = await corpus();
    const austin = programs.find((p) => keyOf(p) === 'austin-arc::austin-arc-scholarships');
    if (austin === undefined) throw new Error('austin-arc-scholarships is missing from the corpus');
    // The funder's whole published rule set, from the real capture of austinhams.org/scholarships/.
    // No ham_activity constraint appears, because the club states no activity requirement anywhere.
    expect(
      austin.constraints.map((c) => ({ axis: c.spec.axis, hard: c.hard, spec: c.spec })),
    ).toEqual([
      {
        axis: 'geography',
        hard: true,
        spec: {
          axis: 'geography',
          geo: {
            type: 'county',
            values: ['Travis', 'Bastrop', 'Blanco', 'Burnet', 'Caldwell', 'Hays', 'Williamson'],
          },
        },
      },
      {
        axis: 'recommendation',
        hard: true,
        spec: { axis: 'recommendation', recommenderType: 'any', count: 1 },
      },
    ]);
    // No individual profile is barred on this axis any more. A recommendation constraint changes
    // no verdict, and the county rule leaves an applicant who has not stated a county UNKNOWN —
    // "we cannot tell without your county", which is the honest answer — rather than excluded.
    expect(activityOf(austin)).toEqual([]);
    expect(matchProgram(licensedFemale, austin, NOW).kind).toBe('unknown');
  });

  it('reads the strapline and the field-of-study list off the page and keeps neither', () => {
    // Verbatim from fixtures/austin-arc/. Four occurrences of "public service" on one page, none
    // of them a requirement: a hero strapline, two brochure sentences, and the "Who can apply"
    // list of STUDY FIELDS. The first was published as `activityKinds: ["public_service"]`, which
    // on an allow-list axis barred every individual applicant.
    const page = [
      'Investing in the Next Generation',
      'Club Scholarships',
      'Supporting Central Texas students who are building the future of technology, public service, and community.',
      'Apply Now →',
      'Eligibility & Dates',
      'Amateur Radio develops practical skills that extend far beyond the radio itself — including',
      'engineering, problem solving, emergency communications, public service, leadership, and lifelong',
      'learning.',
      'Who can apply',
      'Students pursuing higher education or skilled trades — engineering, computer science,',
      'public service, healthcare, and more.',
    ].join('\n');
    expect(extractHamActivity(raw({}, page))).toEqual([]);
    // …and the same page with a real requirement on it still produces one. The gate is about
    // whether a clause states a rule, not about which page it is on.
    const withRequirement = `${page}\nApplicants must be active in a local radio club.`;
    const cs = extractHamActivity(raw({}, withRequirement));
    expect(cs).toHaveLength(1);
    expect(cs[0].spec).toMatchObject({ activityKinds: ['club_member'] });
    expect(cs[0].rawText).toBe('Applicants must be active in a local radio club.');
  });

  it('keeps the ARDC list, which the same page-shaped rules would have swallowed', () => {
    // The exact sentence, verbatim from the ARRL catalogue's `Other:` field. It is a list, it has
    // no modal, and it is introduced by the word "Examples" — every property a wording-based rule
    // would reject. It survives because it was LABELLED as eligibility by the funder.
    const examples =
      'Examples: membership in a local or regional club, participation in amateur radio emergency ' +
      'activities, teaching amateur radio classes, on-the-air activities, participation in college ' +
      'radio clubs, and any similar activities which illustrate his/her interest and participation ' +
      'with the amateur radio avocation.';
    const cs = extractHamActivity(
      raw({
        Other: `2) Applicant must show proof of amateur radio activity during the previous year. ${examples}`,
      }),
    );
    expect(cs).toHaveLength(1);
    // `ares_races_skywarn` comes from "participation in amateur radio emergency activities", the
    // one item in this sentence that names no acronym — see the corpus assertion above.
    expect(cs[0].spec).toMatchObject({
      activityKinds: ['club_member', 'ares_races_skywarn', 'teaching', 'on_air'],
    });
    expect(cs[0].rawText).toBe(examples);
    // Word for word the SAME sentence, reached through the whole-page fallback instead of a
    // labelled field, is not read as a requirement — this is the whole distinction, in one pair.
    expect(extractHamActivity(raw({}, `Club Scholarships\nApply Now →\n${examples}`))).toEqual([]);
  });
});
