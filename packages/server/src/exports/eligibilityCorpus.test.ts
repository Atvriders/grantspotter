import { beforeAll, describe, expect, it } from 'vitest';
import type { ConstraintAxis, Profile, Program, StudentProfile } from '@grantspotter/core';
import { matchAll } from '@grantspotter/core';
import { PROFILES } from '../../../../scripts/profile-corpus.js';
import { buildEligibilityReport, type EligibilityReport } from './eligibility.js';
import { escapeHtml, renderEligibilityReportHtml } from './html.js';
import { loadExportCorpus, type ExportCorpus } from './testCorpus.js';

/**
 * THE ELIGIBILITY REPORT, RUN OVER THE REAL CORPUS.
 *
 * `eligibility.test.ts` proves the shaping against four hand-built records. This file proves the
 * only things that matter about the feature, and neither is provable against hand-built records:
 *
 *   1. The census a real applicant actually gets, per axis — and the fact that GEOGRAPHY is the
 *      largest single exclusion is the interesting half. Those scholarships genuinely are
 *      ARRL-Division, Section and state restricted. Presenting a correct exclusion as a fixable
 *      gap would be the report lying in the applicant's favour, which is the same defect as lying
 *      against them.
 *   2. `unknown` is a real, common, honest state and NEVER a soft "no". A profile that states
 *      nothing leaves most of the corpus unknown, and the only records it excludes outright are
 *      excluded on a fact about the PROGRAMME rather than on an unanswered question.
 *
 * NO NUMBER IS QUOTED IN THIS PARAGRAPH, AND THAT IS DELIBERATE. It used to open with "68 of 150",
 * "36 of the exclusions on GEOGRAPHY" and "an empty profile leaves 117 of 150 unknown and excludes
 * ZERO of them". Every one of those figures is asserted in this file, forty to two hundred lines
 * below — and when `matcher.ts` stopped reading an unrecorded applicant-entity list as a refusal
 * on 2026-08-12, the assertions moved (117 became 136, 28 became 9) and the summary at the top did
 * not, because nothing executes a summary. This project has already paid for that once: a drift
 * guard whose evidence lived in a comment, found in round three. A restated measurement is a
 * second copy of a fact with no test behind it, so this file keeps one copy, in the assertion.
 *
 * The counts below move when fixtures land. UPDATE them, never soften them: they are the same
 * numbers `npm run profile-corpus -- ee-undergrad` prints, and `corpus.test.ts` pins the
 * population they are taken from.
 */

let corpus: ExportCorpus;
let report: EligibilityReport;

const EE_UNDERGRAD = PROFILES.find((p) => p.key === 'ee-undergrad')!.profile;

/**
 * EVERY HARD-BAR AXIS THIS CORPUS CARRIES, not a hand-picked six.
 *
 * This list read `license, field_of_study, geography, citizenship, gpa, age_stage` and said of
 * itself: "`institution`, `recommendation`, `arrl_membership` and `gender` are hard axes too, but
 * these six are the ones that bar the most records: 117, 106, 84, 27, 13 and 12 hard constraints
 * respectively."
 *
 * The six figures are right and the sentence around them is false. Measured over the same corpus:
 * `institution` carries 122 hard constraints — MORE than any of the six, and the largest hard-bar
 * axis in this corpus — and `recommendation` carries 12, level with `age_stage`. So the axis most
 * able to refuse an applicant was the one axis on which "an unset field yields unknown, never
 * ineligible" — the invariant this whole `describe` exists to prove — was never checked, excluded
 * by a claim nothing executed.
 *
 * So the list is now every hard axis the corpus actually carries, and `covers every hard axis the
 * corpus can bar on` below RECOMPUTES that set from the loaded programs and fails if the two
 * differ. It cannot be a list somebody trimmed with a sentence again: a new fixture that
 * introduces a hard axis nobody has exercised here fails the suite, and an axis that leaves the
 * corpus fails it too. (The list cannot simply be derived at module scope — `it.each` is evaluated
 * when the file is collected and `loadExportCorpus` is async — which is exactly the gap the prose
 * was filling. A check is the honest way to fill it.)
 */
const HARD_BAR_AXES: ConstraintAxis[] = [
  'license',
  'field_of_study',
  'geography',
  'citizenship',
  'gpa',
  'age_stage',
  'institution',
  'recommendation',
  'arrl_membership',
  'gender',
  'ham_activity',
];

beforeAll(async () => {
  corpus = await loadExportCorpus();
  report = buildEligibilityReport(
    EE_UNDERGRAD,
    corpus.programs,
    corpus.funders,
    corpus.cyclesByProgramId,
    corpus.now,
  );
});

describe('the census a licensed EE undergraduate actually gets', () => {
  // ROUND SIX MOVED THESE FIGURES, AND EVERY STEP WAS TOWARD THE APPLICANT. Eight hard refusals
  // were measured whose evidence — the funder's own displayed sentence — said the applicant
  // qualified, and `ConstraintSpec` gained the disjunction those funders had written and it could
  // not hold. For THIS profile (a licensed EE undergraduate in Texas) two of the eight move:
  //   The CARA Merit Scholarship   ineligible -> eligible. Its activity list ends "…GOTA, Field
  //                                Day, ETC.", so the list was the funder's examples, not a bar.
  //   Robert A. Rodriguez K5AUW    ineligible -> unknown. "open to graduating high school seniors,
  //                                AND TO PREVIOUS AWARDEES" names a route with no profile field,
  //                                so the axis declines to decide instead of refusing.
  //   MMARSI                       eligible -> eligible_preferred, on the same open-list rule
  //                                applied to a SOFT constraint: no eligibility changed, a rank did.
  // The other five defects are geography and licence tiers this profile does not stand on
  // (Brevard/Gwinnett/Oklahoma/New England, and an Amateur Extra of six months).
  // …AND THE SECOND HALF OF THE SAME ROUND MOVED TWO MORE, both `ineligible -> unknown`, both on
  // `field_of_study` and both for the same reason: the funder named a DOMAIN, and word overlap
  // cannot decide who is inside one.
  //   Carole J. Streeter, KB9JBR  "Medical" — a list of one umbrella that refused all nineteen
  //                               probed majors, Nursing and Radiography included.
  //   Michael Tortorella, W2IY    "Mathematics or data science" — "Mathematics" refuses Statistics.
  // Neither becomes a pass: `orUnrepresented` can only reach `unknown`, so an EE undergraduate is
  // told this could not be worked out and is shown the funder's own sentence, instead of a "no"
  // that sentence does not support.
  // ROUND SEVEN MOVED TWO OF THOSE BACK, AND BOTH WERE CLAIMS THIS PROFILE HAD NOT EARNED. The
  // open-list widening above had been read as a PASS, so a funder's "…GOTA, Field Day, ETC." was
  // answering the applicant's question for them. This EE undergraduate's `activityKinds` are
  // `['club_member','on_air']` — neither is on CARA's list, and CARA's sentence does not say they
  // count; it says the list is not exhaustive, which is a different sentence.
  //   The CARA Merit Scholarship   eligible -> unknown. Not a refusal (the funder opened the list)
  //                                and not an eligibility (nobody said this applicant qualifies).
  //   MMARSI                       eligible_preferred -> eligible. The same rule on a SOFT
  //                                constraint had manufactured a met preference — and the rank
  //                                that comes with it — for an applicant in no emergency
  //                                communications programme. No eligibility changed, a rank did,
  //                                in the opposite direction to the round that added it.
  // The totals are unchanged in aggregate for this profile (69 -> 68 positive) because the two
  // moves cross: CARA leaves `eligible` and MMARSI arrives in it.
  //
  // ROUND EIGHT TOOK ELEVEN MORE OUT OF THE POSITIVE COLUMN AND REFUSED NOBODY. Measured against
  // c1bde9f, the commit immediately before it: 63 positive -> 52, `ineligible` unmoved at 51.
  // Over the whole 54,600-pair sweep (58 profiles — the seven shipped ones plus a resident of each
  // US state and DC — by the 150 publishable programmes) the geography change moved ZERO pairs into
  // `ineligible` and zero out of it. Every move is a claim withdrawn, never a door closed.
  //
  // All eleven are bounded cascades — "Residence in WI. If none identified, residence in the ARRL
  // Central Division (IL, IN, WI)" and its siblings — read against a TEXAS applicant. A cascade
  // softened the whole sentence, and a soft constraint refuses nobody, so it also admitted
  // everybody: this profile was told `eligible` for eleven awards whose funders name Wisconsin,
  // Indiana, Louisiana, South Carolina, Georgia, Florida, Virginia, California and the Shenandoah
  // Valley, and never name Texas. Ten move `eligible -> unknown`; North Fulton moves
  // `eligible_preferred -> unknown`, its rank having come from the field-of-study clause beside the
  // geography one. None becomes a refusal: each record now publishes the funder's whole LADDER as a
  // disjunction, with the funder's own condition in `orUnrepresented`, which can only reach
  // `unknown`.
  //
  // The two the funder itself left open are still here: MMARSI ("and then the remaining USA") and
  // CTRI ("applicants from all regions will be considered") keep their single soft constraint and
  // their verdicts.
  //
  // ROUND NINE TOOK ONE MORE, AND REFUSED NOBODY: 52 positive -> 51, `ineligible` unmoved at 51.
  // The ARRL Foundation Scholarship Program moves `eligible -> unknown` for every individual
  // profile, this one included — its only hard constraint is a `recommendation` axis no profile
  // field can answer, so `eligible` was being published without one requirement having been
  // checked. The round's other change — reading a bare "4-year college or university" as a floor —
  // moves nothing for this profile, which is a bachelor's student at a 4-year school and is inside
  // every one of those 20 sentences. It is measured on the profiles it does move, in
  // `institution.ts` and in the round summary.
  it('reports 51 eligible-or-preferred of 150', () => {
    expect(report.rows).toHaveLength(150);
    expect(report.counts).toEqual({
      eligible: 42,
      eligible_preferred: 9,
      unknown: 48,
      ineligible: 51,
    });
    expect(report.counts.eligible + report.counts.eligible_preferred).toBe(51);
  });

  it('breaks the exclusions down by axis: geography 36, applicant_entity 9, then the small ones', () => {
    const byAxis = new Map<string, number>();
    for (const row of report.rows) {
      if (row.verdict !== 'ineligible') continue;
      for (const axis of new Set(row.reasonAxes.split('; ').filter((a) => a.length > 0))) {
        byAxis.set(axis, (byAxis.get(axis) ?? 0) + 1);
      }
    }
    expect(Object.fromEntries([...byAxis].sort((a, b) => b[1] - a[1]))).toEqual({
      geography: 36,
      // Was `other: 28` — the axis name for "a long-tail requirement no schema captures", which
      // is a false description of where 28 exclusions came from AND buried 19 that were not
      // exclusions at all. 19 of the 28 were records with `applicantEntities: []`, and an empty
      // audience is now `unknown`; the remaining 9 are audiences somebody researched, filed under
      // the name of the gate that produced them.
      applicant_entity: 9,
      // Was `age_stage: 5, ham_activity: 1`. Rodriguez's stage bar became an `unknown` (a route
      // this schema cannot check is not a refusal) and CARA's activity bar became a pass (the
      // funder's own "etc." says the list is illustrative) — so this axis breakdown is now the
      // count of refusals that survive reading the funder's whole sentence.
      age_stage: 4,
      // Was 5. Streeter's "Medical" and Tortorella's "Mathematics" are domains this schema cannot
      // adjudicate membership of; the three that remain name actual fields.
      field_of_study: 3,
      gpa: 1,
    });
  });

  /**
   * NOTHING IS REFUSED SILENTLY, AND NOTHING IS REFUSED IN A VOICE THAT IS NOT ITS OWN.
   *
   * The old form of this test — `every(r => r.reasons.trim().length > 0)` — was satisfied by the
   * defect it was written to prevent: 28 of the 74 rows satisfied it with a sentence GrantSpotter
   * had composed and written into `rawText` in the funder's voice, and for a collegiate 501(c)(3)
   * club 144 of 145 did. "Every exclusion has text" is not the property that matters; "every
   * exclusion has text AND the reader can tell who wrote it" is.
   */
  it('gives every excluded record a reason, attributed to whoever actually wrote it', () => {
    const excluded = report.rows.filter((r) => r.verdict === 'ineligible');
    expect(excluded).toHaveLength(51);
    expect(excluded.every((r) => r.reasonAxes.trim().length > 0)).toBe(true);
    // Something is always said...
    expect(
      excluded.every((r) => r.reasons.trim().length > 0 || r.reasonsFromGrantSpotter.trim().length > 0),
    ).toBe(true);
    // ...and the funder's column carries only what a funder wrote. 42 of the 51 quote a page; the
    // other 9 are the applicant-entity gate, whose text is this software's and is filed as such.
    expect(excluded.filter((r) => r.reasons.trim().length > 0)).toHaveLength(42);
    expect(excluded.filter((r) => r.reasonsFromGrantSpotter.trim().length > 0)).toHaveLength(9);
    expect(
      excluded.filter((r) => r.reasons.trim().length > 0 && r.reasonAxes.includes('applicant_entity')),
    ).toEqual([]);
  });

  /**
   * THE SENTENCE THE PRODUCT USED TO WRITE FOR A FUNDER, PINNED BY ITS TEXT.
   *
   * `grep -rn "accepts applications from|does not accept" packages e2e` found those two literals
   * in `matcher.ts` and nowhere else: no funder page, no fixture, no seed record ever contained
   * them. They were rendered inside `.explain-raw` in the browser and under a column headed "in
   * the funder's words" on the printed page. A regression here means the fabrication came back.
   */
  it('never prints a funder sentence that no funder wrote', () => {
    const html = renderEligibilityReportHtml(report);
    for (const forbidden of ['accepts applications from', 'does not accept', '(none recorded)']) {
      expect(html, forbidden).not.toContain(forbidden);
    }
    // …and no enum identifier reaches the reader in place of English.
    for (const row of report.rows) {
      expect(row.reasons, row.programId).not.toMatch(/[a-z]+_[a-z]+_[a-z]/);
      expect(row.reasonsFromGrantSpotter, row.programId).not.toMatch(/[a-z]+_[a-z]+_[a-z]/);
    }
  });

  it('marks a GrantSpotter-authored reason as such in the printed report', () => {
    const authored = report.rows.find(
      (r) => r.verdict === 'ineligible' && r.reasonsFromGrantSpotter !== '',
    )!;
    expect(authored.reasons).toBe('');
    expect(authored.reasonsFromGrantSpotter).toContain('GrantSpotter, not the funder');
    const html = renderEligibilityReportHtml(report);
    expect(html).toContain(
      `<span class="axis">applicant_entity</span><span class="authored-by">GrantSpotter, not the funder</span>` +
        `<span class="authored">${escapeHtml(authored.reasonsFromGrantSpotter)}</span>`,
    );
    // The verbatim class is reserved for verbatim text and must not wrap this.
    expect(html).not.toContain(
      `<span class="rawtext">${escapeHtml(authored.reasonsFromGrantSpotter)}</span>`,
    );
  });

  it('renders a geography exclusion as the funder’s own restriction, quoted', () => {
    const geo = report.rows.find(
      (r) => r.verdict === 'ineligible' && r.reasonAxes.includes('geography'),
    )!;
    // A real one: "Residence in ARRL Rocky Mountain Division (CO, NM, UT or WY)".
    expect(geo.reasons).toMatch(/ARRL|Division|Section|County|resident|Residence|[A-Z]{2}\b/);
    expect(geo.missingFields).toBe('');
    const html = renderEligibilityReportHtml(report);
    // The funder's sentence, verbatim, with the axis the product read it as beside it.
    expect(html).toContain(
      `<span class="axis">geography</span><span class="rawtext">${escapeHtml(geo.reasons)}</span>`,
    );
  });

  it('never files an ineligible record under "missing from your profile"', () => {
    // The two columns answer different questions and the report must not blur them: an exclusion
    // is something the funder decided, a missing field is something the reader can do.
    expect(report.rows.every((r) => r.verdict !== 'ineligible' || r.missingFields === '')).toBe(
      true,
    );
    expect(report.rows.every((r) => r.verdict !== 'unknown' || r.reasons === '')).toBe(true);
  });
});

describe('an unset profile field yields unknown, never ineligible', () => {
  let empty: EligibilityReport;
  let verdicts: ReturnType<typeof matchAll>;

  beforeAll(() => {
    const blank: StudentProfile = { kind: 'student' };
    empty = buildEligibilityReport(
      blank as Profile,
      corpus.programs,
      corpus.funders,
      corpus.cyclesByProgramId,
      corpus.now,
    );
    verdicts = matchAll(blank as Profile, corpus.programs, corpus.now);
  });

  // 141 AND 0 — AND THE ZERO IS THE WHOLE POINT OF THE COLUMN. A profile that has answered
  // NOTHING is now told `eligible` by nothing at all in this corpus.
  //
  // The last one was the ARRL Foundation Scholarship Program, whose only hard constraint is a
  // `recommendation` axis: no profile field can ever answer it, so it came back `not_evaluable`,
  // `not_evaluable` does not block, and a record with nothing else in it published `eligible` on
  // the strength of a requirement nobody had looked at. It is `unknown` now, with nothing to ask
  // for — see `matchProgram`'s `onlyUnanswerableRequirements`.
  //
  // The 140 before it was 140-and-1 since the geography cascade ladder landed, where one record
  // moved `eligible -> unknown` because its ladder asks this blank profile for the one thing that
  // would decide it — a state. The direction is the point in both rounds. An unanswered field
  // still cannot produce a refusal: `ineligible` is the same 9, still all on the applicant-entity
  // gate, asserted immediately below.
  it('leaves 141 of 150 unknown, says yes to none, and refuses only the 9 with a researched audience', () => {
    expect(empty.counts).toEqual({
      eligible: 0,
      eligible_preferred: 0,
      unknown: 141,
      ineligible: 9,
    });
  });

  it('excludes ONLY on the applicant-entity gate, which is a fact and not an unanswered field', () => {
    const axes = new Set(
      empty.rows
        .filter((r) => r.verdict === 'ineligible')
        .flatMap((r) => r.reasonAxes.split('; ')),
    );
    expect([...axes]).toEqual(['applicant_entity']);
  });

  /**
   * AND ONLY WHERE SOMEBODY RESEARCHED THAT AUDIENCE. The gate used to refuse 28; 19 of those 28
   * were records that stated nothing at all about who may apply, which is a hole in GrantSpotter's
   * data and cannot be an answer about a person. Those 19 are `unknown` now.
   */
  it('turns a record that named no audience into a question, never a refusal', () => {
    const silent = corpus.programs.filter((p: Program) => p.applicantEntities.length === 0);
    expect(silent).toHaveLength(19);
    for (const program of silent) {
      const row = empty.rows.find((r) => r.programId === program.id)!;
      expect(row.verdict, program.name).not.toBe('ineligible');
      expect(row.reasons, program.name).toBe('');
      expect(row.reasonsFromGrantSpotter, program.name).toBe('');
    }
  });

  /**
   * THE RATCHET UNDER `HARD_BAR_AXES`, because the list it replaced was trimmed by a sentence.
   *
   * `it.each` is evaluated when this file is collected and the corpus loads asynchronously, so the
   * list above cannot literally be derived. This is the next best thing and it is strictly better
   * than the prose it replaces: the set is recomputed from the loaded programs and compared, so
   * the list cannot silently omit the axis that bars the most records (which is what happened to
   * `institution`, 122 hard constraints, the largest in the corpus and untested until 2026-08-12)
   * and cannot silently keep exercising an axis that has left the fixtures.
   */
  it('covers every hard axis the corpus can bar on, and no axis it cannot', () => {
    const carried = new Set<string>();
    for (const program of corpus.programs) {
      for (const constraint of program.constraints) {
        if (constraint.hard) carried.add(constraint.spec.axis);
      }
    }
    // `financial_need` is forced soft by the matcher whatever the record says (spec §4.5 rule 11),
    // so a hard one in the data is never a bar and is not this list's business.
    carried.delete('financial_need');
    expect([...carried].sort()).toEqual([...HARD_BAR_AXES].sort());
  });

  it.each(HARD_BAR_AXES)(
    'a hard %s bar with nothing to check it against is unknown, never a refusal',
    (axis) => {
      const carriers = corpus.programs.filter((p: Program) =>
        p.constraints.some((c) => c.hard && c.spec.axis === axis),
      );
      // Non-vacuous: this axis really is a hard bar somewhere in the corpus.
      expect(carriers.length).toBeGreaterThan(0);

      const refusedOnThisAxis = carriers.filter((p) => {
        const v = verdicts.get(p.id);
        return v?.kind === 'ineligible' && v.reasons.some((c) => c.spec.axis === axis);
      });
      expect(refusedOnThisAxis).toEqual([]);

      // ...and at least one of them says so out loud rather than falling through to `eligible`.
      const said = carriers.filter((p) => verdicts.get(p.id)?.kind === 'unknown');
      expect(said.length).toBeGreaterThan(0);
    },
  );

  /**
   * SPLIT, NOT RELAXED — the same shape `e2e/api.spec.ts` had to take when an unmeasurable radius
   * learned to say `unknown` with nothing to ask for. There are two kinds of unknown and they are
   * counted separately, because "an unknown that asks for nothing" must never spread quietly:
   *
   *   119  waiting on a profile field this blank profile has not filled in. (118 until the cascade
   *        ladders were published; the one that moved is waiting on `state`, which is exactly the
   *        kind of unknown this column is for.)
   *    21  waiting on nothing the reader can supply. 18 until c1bde9f, whose three additions are
   *        its own and are named in its message — NCDXF Grant Program, SARA Student and Teacher
   *        Project Grants and the Yaesu System Fusion DR-2X Repeater Program, each an `eligible`
   *        that nobody had written. The geography cascade ladder of the same round changed this
   *        set by nothing at all: measured both ways, the 21 names are identical, because a
   *        blank profile's cascade unknown is waiting on `state` and is counted above.
   *        The 18 were — 16 records whose audience nobody recorded,
   *        the Yankee Clipper radius whose centre never resolved, and the ARRL Foundation Special
   *        Funds, which moved here in round six: the only question it had for an individual came
   *        from "GROUPS THAT QUALIFY for mini-grants will include… CLUB ACTIVITIES", a rule about
   *        organisations that could only ever refuse a person. Asking a student what they do on
   *        the air could not have changed that verdict, so the axis no longer asks. For all
   *        eighteen the missing thing is in GrantSpotter's data, and sending the reader to the
   *        profile editor would be asking them to fix our hole by typing something about
   *        themselves.
   *
   * (16 of the 19 silent-audience records, not 19: the other three also carry a hard axis that
   * this blank profile CAN answer, so they name that field instead and are counted above.)
   */
  it('names the field each unknown is waiting on wherever the profile could supply one', () => {
    const unknowns = empty.rows.filter((r) => r.verdict === 'unknown');
    expect(unknowns).toHaveLength(141);
    const answerable = unknowns.filter((r) => r.missingFields.length > 0);
    const unanswerable = unknowns.filter((r) => r.missingFields.length === 0);
    expect(answerable).toHaveLength(119);
    // 21 until the ARRL Foundation Scholarship Program joined them: its only hard constraint is a
    // letter of recommendation, which is a packet item and not a profile field, so there is
    // nothing to ask this reader for — the same empty list the other 21 carry.
    expect(unanswerable).toHaveLength(22);
    // An unknown is never dressed as an exclusion, whichever kind it is.
    expect(unknowns.every((r) => r.reasons === '' && r.reasonsFromGrantSpotter === '')).toBe(true);
  });
});

describe('what the printed page says about the corpus it was built from', () => {
  it('never turns an unstated obligation into a funder’s "no"', () => {
    // Across the 150, `costShareRequired` is unstated on 148 and `false` on ZERO.
    const states = new Map<string, number>();
    for (const row of report.rows) states.set(row.costShare, (states.get(row.costShare) ?? 0) + 1);
    expect(states.get('unstated')).toBe(148);
    expect(states.get('not required') ?? 0).toBe(0);
    expect(renderEligibilityReportHtml(report)).not.toContain('not required');
  });

  it('marks a projected deadline as projected — only 4 of the corpus’ cycles are published', () => {
    const bases = new Set(report.rows.map((r) => r.deadlineBasis).filter((b) => b.length > 0));
    expect([...bases].some((b) => /estimated by GrantSpotter, not the funder/.test(b))).toBe(true);
  });

  it('renders 150 table rows and no suppressed record', () => {
    const html = renderEligibilityReportHtml(report);
    expect((html.match(/<tr>/g) ?? []).length).toBe(151); // 150 rows + the header row
    for (const suppressed of corpus.suppressedPrograms.slice(0, 25)) {
      expect(html).not.toContain(`>${suppressed.id}<`);
    }
  });
});
