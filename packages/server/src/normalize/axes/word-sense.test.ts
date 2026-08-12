// `citizenship.ts`, `gender.ts` and `recommendation.ts` — the three axes whose last fabrications
// survived three rounds of chrome guarding, because the text they came from was never chrome.
//
// THE DEFECTS THIS FILE PINS.
//
//  1. CHROME, on two axes the guard had not reached.
//     `nasa-csli` published `citizenship` HARD `{allowed: ["US_CITIZEN"]}` because the ONLY
//     occurrence of the word "citizen" anywhere in NASA's CubeSat Launch Initiative capture is the
//     topic link "Citizen Science", in the global nav between "STEM Multimedia" and "View All
//     Topics A-Z". A fabricated citizenship bar hides a programme from every non-US applicant with
//     no signal at all.
//     `ieee-mtts` published `gender` HARD `{allowed: ["female"]}` off "Women in Microwaves (WiM)"
//     in mtt.ieee.org's menu — and, unlike every case before it, `withoutSiteChrome` alone does
//     NOT fix that one: the same page describes the same SUBCOMMITTEE twice in ordinary prose,
//     punctuated exactly like eligibility text. This corpus holds three GENUINE women-only ham
//     scholarships (YLRL's); a spurious fourth both excludes people wrongly and devalues the real
//     ones. See `gender.ts` for why that axis reads only a labelled field.
//
//  2. WORD SENSE, which no provenance rule can see, because the text IS the funder's own prose.
//     `ncdxf-grants` read "…justified without REFERENCE TO these activities" as a demand for one
//     letter of recommendation. "Reference" there means MENTION, and the clause is a NEGATION, so
//     the constraint is wrong twice over. Four more of the same shape are listed in
//     `recommendation.ts`'s NOT_A_LETTER_SENSE, including ARDC's "unless they have a nonprofit
//     FISCAL SPONSOR" — an exception, read as a requirement, on the largest programme here.
//
// The assertions below run the REAL committed captures through the REAL pipeline; the unit checks
// beside them use verbatim strings from those same pages, so a detector that silently stops
// matching fails rather than passing vacuously.
//
// Kept in its own file rather than appended to part1.test.ts / part2.test.ts, which
// concurrently-running agents edit for other axes — the same reason license.test.ts,
// hamActivity.test.ts, chrome-scope.test.ts and preference-scope.test.ts exist.
import type { Program, RawOpportunity } from '@grantspotter/core';
import { describe, expect, it } from 'vitest';
// The offline corpus loader: every committed REAL capture, parsed by its own source module and
// normalized exactly as the crawler does, minus the records the review queue suppresses. Shared
// with `scripts/profile-corpus.ts` rather than reimplemented, so no two audits can disagree about
// what "the corpus" is.
import { loadCorpus } from '../../../../../scripts/profile-corpus.js';
import { extractCitizenship } from './citizenship.js';
import { extractGender } from './gender.js';
import { withoutSiteChrome } from './hamActivity.js';
import { extractRecommendation } from './recommendation.js';

let cached: ReturnType<typeof loadCorpus> | undefined;
function corpus(): ReturnType<typeof loadCorpus> {
  cached ??= loadCorpus();
  return cached;
}

function keyOf(program: Program): string {
  const tag = (prefix: string): string =>
    program.tags.find((t) => t.startsWith(prefix))?.slice(prefix.length) ?? '?';
  return `${tag('source:')}::${tag('key:')}`;
}

const raw = (fields: Record<string, string>, rawText?: string): RawOpportunity => ({
  sourceId: 's',
  externalKey: 'k',
  name: 'n',
  rawFields: fields,
  sourceUrl: 'https://example.test/x',
  rawText: rawText ?? Object.values(fields).join('\n'),
});

async function specsFor(key: string, axis: string): Promise<unknown[]> {
  const { programs } = await corpus();
  const p = programs.find((program) => keyOf(program) === key);
  if (p === undefined) throw new Error(`${key} is missing from the corpus`);
  return p.constraints.filter((c) => c.spec.axis === axis).map((c) => c.spec);
}

// ------------------------------------------------------------ the three named defects, on the
// ------------------------------------------------------------ real captures

describe('the constraints that were read off page furniture', () => {
  it('NASA CSLI asserts no citizenship — "Citizen Science" is a topic link', async () => {
    expect(await specsFor('nasa-csli::nasa-csli', 'citizenship')).toEqual([]);
  });

  it('IEEE MTT-S bars no gender — "Women in Microwaves" is a subcommittee', async () => {
    expect(await specsFor('ieee-mtts::ieee-mtts-chapter-support', 'gender')).toEqual([]);
  });

  it('ARRL Foundation Special Funds asserts no citizenship — that was an article title', async () => {
    // `OPEN_WORLDWIDE` found the word "Worldwide" inside the 2024 Bill Orr winner's QST byline,
    // "Worldwide Fun with 100 W and a Dipole", and published `{allowed: ["ANY"]}` quoting two
    // decades of the award's winners roll as the ARRL Foundation's stated eligibility.
    expect(await specsFor('arrl-foundation-special-funds::foundation-special-funds', 'citizenship')).toEqual(
      [],
    );
  });

  it('NCDXF asks for no recommendation — "reference" there means mention', async () => {
    expect(await specsFor('ncdxf-grants::ncdxf-grant-program', 'recommendation')).toEqual([]);
  });
});

// ------------------------------------------------------------ the legitimate cases, untouched

describe('the constraints the funders really did state', () => {
  it("YLRL's three named scholarships and its umbrella keep a hard female-only bar", async () => {
    for (const key of [
      'ylrl::ylrl-ethel-smith-k4lmb',
      'ylrl::ylrl-mary-lou-brown-nm7n',
      'ylrl::ylrl-marte-wessel-k0epe',
      'ylrl::ylrl-scholarships',
    ]) {
      expect(await specsFor(key, 'gender')).toEqual([{ axis: 'gender', allowed: ['female'] }]);
    }
  });

  it('the ARRL catalog states exactly one gender scope, and it is a soft preference', async () => {
    const { programs } = await corpus();
    const gendered = programs.flatMap((p) =>
      p.constraints
        .filter((c) => c.spec.axis === 'gender')
        .map((c) => `${keyOf(p)} hard=${c.hard} ${JSON.stringify(c.rawText)}`),
    );
    // Five, corpus-wide — the four YLRL awards above plus Helen Laughlin, and nothing else.
    expect(gendered.length).toBe(5);
    expect(
      gendered.filter((g) => g.startsWith('arrl-scholarship-descriptions::')),
    ).toEqual([
      'arrl-scholarship-descriptions::The Helen Laughlin AM Mode Memorial Scholarship hard=false ' +
        '"Preference is given to women Amateur Radio operators who are performing at a high academic level."',
    ]);
  });

  it('every recommendation constraint left in the corpus names a document about the applicant', async () => {
    // Scale-free, deliberately: a hand-set count of surviving constraints is the same instrument
    // as the corpus-size floor the vacuity guard was just rewritten to stop being — it moves every
    // time a fixture is re-captured, and it is only ever lowered. The claim asserted here is the
    // one the axis actually makes.
    const LETTER_SENSE =
      /\bletters?\s+of\s+(?:reference|recommendation)s?\b|\brecommendations?\s+(?:from|by)\b|\b(?:counsel(?:l)?ors?|teachers?|officers?)\s+(?:(?:or|and)\s+\w+\s+)?recommendations?\b|\bletter from\b|\breferences?\b|\bsponsors?\b/i;
    const { programs } = await corpus();
    const offenders: string[] = [];
    for (const program of programs) {
      for (const c of program.constraints) {
        if (c.spec.axis !== 'recommendation') continue;
        if (!LETTER_SENSE.test(c.rawText)) {
          offenders.push(`${keyOf(program)}: ${JSON.stringify(c.rawText.slice(0, 140))}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the five programmes that fabricated one no longer publish it', async () => {
    for (const key of [
      'ariss::ariss-iss-contact-proposal',
      'arrl-etp-grants::etp-grants',
      'ieee-mtts::ieee-mtts-chapter-support',
      'ncdxf-grants::ncdxf-grant-program',
    ]) {
      expect(await specsFor(key, 'recommendation')).toEqual([]);
    }
    // ARRL Foundation Special Funds keeps one, RE-ANCHORED off the winners roll and onto the
    // sentence the funder wrote: "An applicant for a mini-grant must write a brief, but complete
    // proposal including such items as: * Names, call signs (if applicable), addresses and
    // telephone numbers of sponsors …" — a genuine demand for third-party backing.
    const kept = await corpus().then(({ programs }) =>
      programs
        .filter((p) => keyOf(p) === 'arrl-foundation-special-funds::foundation-special-funds')
        .flatMap((p) => p.constraints.filter((c) => c.spec.axis === 'recommendation')),
    );
    expect(kept).toHaveLength(1);
    expect(kept[0].rawText).toContain('An applicant for a mini-grant must write');
    expect(kept[0].rawText).not.toContain('Winners:');
  });

  it('the ARDC Scholarships still require three letters of recommendation from teachers', async () => {
    expect(
      await specsFor(
        'arrl-scholarship-descriptions::The Amateur Radio Digital Communications (ARDC) Scholarships',
        'recommendation',
      ),
    ).toEqual([{ axis: 'recommendation', recommenderType: 'teacher', count: 3 }]);
  });

  it('the 27 citizenship constraints left are all funder sentences, not furniture', async () => {
    const { programs } = await corpus();
    const offenders: string[] = [];
    for (const program of programs) {
      for (const c of program.constraints) {
        if (c.spec.axis !== 'citizenship' && c.spec.axis !== 'gender') continue;
        if (withoutSiteChrome(c.rawText) !== c.rawText) {
          offenders.push(`${keyOf(program)} ${c.spec.axis}: ${JSON.stringify(c.rawText.slice(0, 120))}`);
        }
      }
    }
    // The corpus-wide form of the claim, mirroring the one hamActivity.test.ts and
    // chrome-scope.test.ts each make for their axes: a published constraint's own quoted evidence
    // may not CONTAIN a navigation run.
    expect(offenders).toEqual([]);
  });
});

// ------------------------------------------------------------ the rules themselves, on verbatim
// ------------------------------------------------------------ strings from those same captures

describe('recommendation: which sense of the word the funder is using', () => {
  const reco = (text: string): unknown[] =>
    extractRecommendation(raw({ Other: text })).map((c) => c.spec);

  it('drops "reference" meaning MENTION — NCDXF, verbatim', () => {
    expect(
      reco(
        'Expeditions to unusual locations as defined by the Islands on the Air (IOTA) program, ' +
          'Grid Square awards and various radio contests are not supported unless the support can ' +
          'be justified without reference to these activities.',
      ),
    ).toEqual([]);
  });

  it('drops "recommendations" meaning PUBLISHED GUIDANCE — ARRL ETP, both sentences, verbatim', () => {
    expect(
      reco(
        'If your interest is in preparing a station for an ISS contact through the ARISS program ' +
          'you will need to research the current ARISS recommendations to get a listing of the ' +
          'radio power and frequency step resolution suggestions and station configuration ' +
          'recommendations set by the ARISS program.',
      ),
    ).toEqual([]);
    expect(
      reco(
        'These recommendations are more elaborate than needed for a casual FM satellite contact.',
      ),
    ).toEqual([]);
  });

  it('drops a FISCAL SPONSOR — ARDC, verbatim, and note the clause is an exception', () => {
    expect(
      reco(
        'Radio clubs and groups who are NOT nonprofits, as well as individual applicants, are not ' +
          'eligible for a grant unless they have a nonprofit fiscal sponsor.',
      ),
    ).toEqual([]);
  });

  it("drops the FUNDER'S OWN sponsors — ARISS, verbatim", () => {
    expect(
      reco(
        'ARISS appreciates our partners and sponsors: National Amateur Radio Societies and AMSAT ' +
          'Organizations (in the USA: ARRL and AMSAT-NA) in Canada, Europe, Japan, Russia and the USA.',
      ),
    ).toEqual([]);
  });

  it('drops a SPONSORSHIP REQUEST — IEEE MTT-S, verbatim', () => {
    expect(
      reco('A sponsorship request usually requires a detailed description and mandatory post-event reporting.'),
    ).toEqual([]);
  });

  it('drops "clubs THAT SPONSOR subgroups" — ARRL Special Funds, verbatim', () => {
    expect(
      reco(
        'Groups that qualify for mini-grants will include, but not be limited to, high school ' +
          'radio clubs, youth groups, and general-interest radio clubs that sponsor subgroups of ' +
          'young people or otherwise make a special effort to get them involved in club activities.',
      ),
    ).toEqual([]);
  });

  it('KEEPS every letter frame the corpus actually uses', () => {
    expect(
      reco(
        '3) Three letters of recommendation must be provided from teachers, local radio club ' +
          "officers and/or others with familiarity with the applicant's character.",
      ),
    ).toEqual([{ axis: 'recommendation', recommenderType: 'teacher', count: 3 }]);
    expect(
      reco('applicant must submit a letter of recommendation from a sitting officer of an ARRL-affiliated club'),
    ).toEqual([
      { axis: 'recommendation', recommenderType: 'arrl_affiliated_club_officer', count: 1 },
    ]);
    // "recommendations AS TO how" — the intervening "as" is what separates the genuine article
    // from "reference TO"; a rule spelled without it would have deleted three real scholarships.
    expect(
      reco(
        '2) Applicant must be performing at a high academic level or an at-risk youth with at ' +
          'least two counselor or teacher recommendations as to how and why they have turned ' +
          'their lives around.',
      ),
    ).toEqual([{ axis: 'recommendation', recommenderType: 'teacher', count: 1 }]);
    // Bare "references" in a list of application documents — Austin ARC. The frame rule is scoped
    // to "recommendation" alone precisely so this survives.
    expect(
      reco("Review the criteria above and gather the documents you'll need (transcript, references, essay)."),
    ).toEqual([{ axis: 'recommendation', recommenderType: 'any', count: 1 }]);
  });

  it('keeps a letter frame that DOES take a bare "to"', () => {
    // No capture writes this today. It is ordinary English, and the `letters? of` lookbehind is
    // what keeps the mention-sense rule from becoming a fabrication in the other direction.
    expect(reco('Two letters of reference to be submitted by the application deadline.')).toEqual([
      { axis: 'recommendation', recommenderType: 'any', count: 2 },
    ]);
  });

  it('still reads a genuine requirement stated beside a non-letter sense', () => {
    // Neutralise-and-retest, not veto-the-clause: one sentence may do both.
    expect(
      reco(
        'Applicants must submit a letter of recommendation from a teacher, and may apply through ' +
          'a nonprofit fiscal sponsor.',
      ),
    ).toEqual([{ axis: 'recommendation', recommenderType: 'teacher', count: 1 }]);
  });

  /**
   * ...AND A THIRD WAY THE WORD IS NOT A REQUIREMENT: THE FUNDER'S OWN HEDGE.
   *
   * A signal that survives only INSIDE a list the funder opened ("such as", "such items as",
   * "including but not limited to") is an EXAMPLE. Two records in the corpus are made entirely of
   * that shape and both published a HARD bar off it — and one of them, the ARRL Foundation
   * Scholarship Program, is the deadline owner for 112 catalogue entries, so its single fabricated
   * requirement was enough to make the catalogue's front door read `unknown` to every student in
   * every state.
   *
   * `data/seed/programs.curated.json` — this project's own hand-reviewed record of the same
   * programme — already carries that sentence as `hard: false` with the reviewer's note "Which
   * ones is an entry-level fact, not a programme-level one." The crawl-side extractor disagreed
   * with the product's reviewed data about the same sentence on the same page.
   *
   * SOFT, NOT DROPPED. The funder wrote the sentence and an applicant needs to read it; a soft
   * constraint is displayed, bars nobody, and — this axis being `not_evaluable` by construction —
   * is never counted as a preference anybody met either.
   */
  const hardness = (text: string): boolean[] =>
    extractRecommendation(raw({ Other: text })).map((c) => c.hard);

  it('reads a hedged example as a note, not a bar — ARRL Foundation, verbatim', () => {
    const arrl =
      'A number of scholarships require additional documents, such as a letter of recommendation ' +
      'from a sitting Officer of an ARRL-affiliated club.';
    expect(reco(arrl)).toEqual([
      { axis: 'recommendation', recommenderType: 'arrl_affiliated_club_officer', count: 1 },
    ]);
    // The sentence is kept and shown. Only its FORCE is withdrawn, because the funder withdrew it.
    expect(hardness(arrl)).toEqual([false]);
  });

  it('…and the same for a signal that is only an ITEM in an illustrative list', () => {
    // ARRL Foundation Special Funds, verbatim. The signal is the word "sponsors" inside a list of
    // things a PROPOSAL should contain; nobody writes a letter about the applicant here.
    expect(
      hardness(
        'An applicant for a mini-grant must write a brief, but complete proposal including such ' +
          'items as: Names, call signs (if applicable), addresses and telephone numbers of sponsors',
      ),
    ).toEqual([false]);
  });

  it('keeps a requirement stated IN FRONT of the funder’s own examples — CWops, verbatim', () => {
    // Neutralise the opened span and retest, the same shape as the sense rules above: the funder
    // opened a list of PROOFS, and the letter requirement is stated before the marker.
    const cwops =
      'Demonstrated CW operating ability within the last 24 months by providing a copy of a ' +
      'certificate, listing in a magazine showing results or a letter from a person responsible ' +
      'for membership (Examples include but are not limited to: ARRL Code Proficiency certificate ' +
      'at 15 wpm or higher; successful completion of CWA Basic Level or higher)';
    expect(hardness(cwops)).toEqual([true]);
    // …as is a plain requirement with no hedge anywhere in it — ARDC, the largest programme here.
    expect(
      hardness(
        'Three letters of recommendation must be provided from teachers, local radio club officers ' +
          "and/or others with familiarity with the applicant's character.",
      ),
    ).toEqual([true]);
  });
});

describe('gender: only a field the funder labelled as eligibility', () => {
  it("reads YLRL's bullet", () => {
    expect(extractGender(raw({ eligibility: 'Applicant must be female.' })).map((c) => c.spec)).toEqual([
      { axis: 'gender', allowed: ['female'] },
    ]);
  });

  it("reads the ARRL catalog's Other field", () => {
    expect(
      extractGender(
        raw({ Other: 'Preference is given to women Amateur Radio operators who are performing at a high academic level.' }),
      ).map((c) => c.rawText),
    ).toEqual([
      'Preference is given to women Amateur Radio operators who are performing at a high academic level.',
    ]);
  });

  it('reads NOTHING off an unlabelled page, menu or prose — IEEE MTT-S, verbatim', () => {
    const page =
      'Broadening Participation Committee\nMentor–Mentee Initiative\nWomen in Microwaves (WiM)\n' +
      'Special Interest Group on Humanitarian Technology (SIGHT)\n' +
      'Women in Microwaves (WiM) – is the subset of Women in Engineering (WIE) working within the ' +
      'field of microwave engineering and typically active within the MTT society.\n' +
      'Funding applications can be made through the Affinity Funding form, selecting Women in ' +
      'Microwaves as the funding program.';
    expect(extractGender(raw({ summary: 'MTT-S provides annual financial support.' }, page))).toEqual([]);
  });

  it('gives up an unlabelled prose scope, deliberately and knowingly', () => {
    // Documented cost, asserted so it cannot be lost by accident: a false INCLUDE the applicant
    // corrects by reading the funder's page, chosen over a false EXCLUDE that hides the award.
    expect(extractGender(raw({}, 'This scholarship is open only to women.'))).toEqual([]);
  });
});

describe('citizenship: a nav link is not a nationality requirement', () => {
  it('ignores NASA\'s "Citizen Science" topic link, verbatim', () => {
    const nav =
      'Image of the Day\ne-Books\n3D Resources\nInteractives\nSTEM Multimedia\nCitizen Science\n' +
      'View All Topics A-Z\nHome\nMissions\nHumans in Space';
    expect(extractCitizenship(raw({ summary: 'CSLI provides launch opportunities.' }, nav))).toEqual([]);
  });

  it('still reads every citizenship sentence the ARRL catalog states', () => {
    for (const sentence of [
      'Applicant must be a US citizen.',
      'Must be a citizen of the United States but without regard to gender, race, national origin, handicap status or any other factor.',
      '1) U.S. citizen',
      'U.S. citizenship',
    ]) {
      expect(extractCitizenship(raw({ Other: sentence })).map((c) => c.spec)).toEqual([
        { axis: 'citizenship', allowed: ['US_CITIZEN'] },
      ]);
    }
  });

  it('still reads the two genuinely worldwide programmes', () => {
    expect(
      extractCitizenship(raw({ Other: 'US licensure, US residence and US citizenship are not requirements.' })).map(
        (c) => c.spec,
      ),
    ).toEqual([{ axis: 'citizenship', allowed: ['ANY'] }]);
    expect(
      extractCitizenship(
        raw({ Other: 'The CWops Scholarship is open to any qualified applicant regardless of location or nationality.' }),
      ).map((c) => c.spec),
    ).toEqual([{ axis: 'citizenship', allowed: ['ANY'] }]);
  });
});
