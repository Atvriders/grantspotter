import type { Program } from '@grantspotter/core';
import { describe, expect, it } from 'vitest';
// The offline corpus loader: every committed REAL capture, parsed by its own source module and
// normalized exactly as the crawler does, minus the records `buildReviewItems` suppresses. Shared
// with `scripts/profile-corpus.ts` and with `packages/core/test/matcher.test.ts` rather than
// reimplemented, so this audit and the profiler can never disagree about what "the corpus" is.
import { loadCorpus } from '../../../../scripts/profile-corpus.js';

/**
 * THE MISSING-LICENCE-FLOOR INVARIANT.
 *
 * Five wrong awards across three sources have had exactly one shape:
 *
 *   1. `qcwa` — the live page says applications are "requested by interested licensed radio
 *      amateurs" and "Scholarships are awarded to worthy Amateur Radio operators". The parser
 *      filed that under `eligibility`.
 *   2-4. `ylrl` x3 — "Applicant must have an Amateur Radio License." is a bullet that applies to
 *      all three named scholarships. The parser filed it under `eligibility`.
 *   5. `ncdxf-scholarships` — "There is no restriction as to class of license. If you are a
 *      licensed amateur radio operator 25 years of age or younger, you can apply…". The parser
 *      filed those under `age` and `applyNote`.
 *
 * Every one: a real page states a licence requirement, the source files it under a field
 * `extractLicense` never reads (it reads `License Requirement` and `license`, nothing else), the
 * Program publishes with no licence constraint, and a funding desk whose entire subject is amateur
 * radio shows a licensed-operators-only award to an unlicensed applicant. That is the one
 * direction this product must not fail in.
 *
 * The shape is SILENT BY CONSTRUCTION in both of the ways that matter. Nothing errors — the
 * sentence is captured, stored and even displayed, just under the wrong key. And it does not move
 * the `hs-unlicensed` profiler figure either, because a program with NO constraint on an axis
 * lands an applicant in the `unknown` bucket rather than `eligible`; NCDXF sat there through the
 * two rounds that fixed its four siblings.
 *
 * This test makes the shape LOUD, corpus-wide, over every real captured fixture rather than only
 * the ARRL catalogue. It applies two complementary rules, both allow-listed from the same table so
 * that "this program has no licence floor" is a statement somebody signed rather than an accident:
 *
 *   RULE A — TEXT-TRIGGERED. If a program's own text plainly states an amateur radio licence and
 *   the Program carries no hard licence floor, fail. This is the defect above, stated directly.
 *
 *   RULE B — POPULATION-SCOPED. Every program an INDIVIDUAL can apply for and that carries no hard
 *   licence floor must be listed, whether or not its text mentions a licence. Rule A alone cannot
 *   see a source whose licence sentence disappears entirely (a page rewrite, or a required-field
 *   pattern that goes quiet) — the text would then be gone from the surface it scans, and the
 *   record would fall silently back to "open to everyone" with nothing to trigger on. Rule B is
 *   scoped to individual-facing programs because `matcher.ts` returns NOT_EVALUABLE for the
 *   `license` axis on any organisation profile: a licence floor on a club grant changes no verdict
 *   for anybody, so demanding one there would be ceremony, not safety.
 *
 * It follows the invariants in this repo that already work this way and were each proven by
 * deliberate break: `sources/registry.test.ts`, the ARRL label-prefix table, and its closest
 * sibling `rawFieldsContract.test.ts` — whose two-list structure (BY_DESIGN vs KNOWN_DEFECTS) is
 * reused below, because "this is fine" and "this is broken and out of the current blast radius"
 * are different statements and collapsing them is how a defect becomes documentation.
 *
 * THIS ONE WAS PROVEN THE SAME WAY: with the `license` pattern removed from
 * `sources/tier-c-b.ts`, it fails naming `ncdxf-scholarships::ncdxf-w6een-scholarship` on both
 * rules. The self-check block at the foot re-proves the detector against all five historical
 * sentences verbatim, so a scanner that silently stops seeing anything fails rather than passing
 * vacuously.
 */

// ---------------------------------------------------------------- the corpus

/**
 * Loaded once. `loadCorpus` re-parses every committed fixture, which is about a second of work,
 * and every assertion below wants the same snapshot.
 */
let cached: ReturnType<typeof loadCorpus> | undefined;
function corpus(): ReturnType<typeof loadCorpus> {
  cached ??= loadCorpus();
  return cached;
}

/**
 * `source::externalKey` — the ingest identity (RESOLUTIONS R1/R9), carried on every Program as the
 * `source:` and `key:` tags. Deliberately NOT `Program.id`, which is minted per run, and not the
 * display name, which a funder rewriting its page can change without changing the program.
 */
function keyOf(program: Program): string {
  const tag = (prefix: string): string =>
    program.tags.find((t) => t.startsWith(prefix))?.slice(prefix.length) ?? '?';
  return `${tag('source:')}::${tag('key:')}`;
}

/**
 * Does this program actually bar an unlicensed applicant?
 *
 * Three states all mean NO, and conflating them is how two of the five defects hid:
 *   - no `license` constraint at all — the five defects above;
 *   - `licenseMin: 'NONE'` — a real answer for exactly one award in this corpus (North Fulton),
 *     but functionally identical to having no constraint;
 *   - a SOFT `license` constraint — `makeConstraint` classifies a whole sentence as a preference
 *     when `isPreferenceText` fires anywhere in it, and `matcher.ts` never excludes on a soft
 *     constraint. Three ARRL entries state a requirement and a preference in ONE sentence
 *     ("Any active Amateur Radio License Class for two years, preference for General Class") and
 *     lose the requirement half that way. A test that only counted constraints would have called
 *     all three protected.
 */
function licenceFloorOf(program: Program): string | undefined {
  for (const c of program.constraints) {
    if (c.spec.axis !== 'license' || !c.hard) continue;
    if (c.spec.licenseMin === 'NONE') continue;
    return c.spec.licenseMin;
  }
  return undefined;
}

/**
 * WHERE THE AUDIT LOOKS. `Program` drops `rawFields` wholesale, so this is every place a source's
 * captured prose survives normalization:
 *   - `rawOtherText` — `buildRawOtherText` falls back to the WHOLE flattened page for every
 *     single-page ham source, and is the funder's own `Other` block for an ARRL catalog entry;
 *   - `summary` — for an ARRL entry this is the whole "Award Amount: … License Requirement: …"
 *     preamble, which `rawOtherText` does not repeat;
 *   - `applyContact` — `rawFields.applyNote`, which is exactly where NCDXF's licence sentence was
 *     hiding;
 *   - every constraint's `rawText` — the sentence each extractor did read, so a licence stated
 *     inside another axis's captured text is still visible here;
 *   - `name`.
 */
function textSurfaceOf(program: Program): string {
  return [
    program.name,
    program.summary,
    program.applyContact ?? '',
    program.rawOtherText,
    ...program.constraints.map((c) => c.rawText),
  ].join('\n');
}

/**
 * "This page plainly talks about an amateur radio licence."
 *
 * PRAGMATIC ON PURPOSE, in both directions. It is not a licence-requirement parser — it is a
 * trigger for human review, and every false positive it produces is resolved by one allow-list
 * entry with a reason. A regex that catches the five real cases beats a perfect one that catches
 * none. Widening it is cheap; the cost of a miss is a wrong award.
 *
 * Each alternative earns its place against real corpus text:
 *   - `amateur radio licence` / `ham licence` — YLRL's bullet, NEAR-Fest's tenure sentence, and
 *     the Radio Club of America record's "A ham licence is NOT required" (a NEGATION, and exactly
 *     the false positive this design accepts and allow-lists).
 *   - `licensed radio amateurs` / `licensed amateur radio operator` — QCWA and NCDXF.
 *   - `amateur radio operator` — QCWA's second statement and the ARRL Foundation portal's
 *     "for eligible amateur radio operators pursuing higher education".
 *   - `license class` / `class of … license` — NCDXF's "no restriction as to class of license",
 *     and the "Any active Amateur Radio License Class" family used by 40+ catalog entries.
 *   - `License Requirement` — the ARRL catalog's own field LABEL. Every one of the 111 entries
 *     carries it, so any catalog entry that states a licence rule and still ends up without a
 *     floor is caught, including the one whose stated value is the bare word "None".
 *   - `FCC-issued` — the other common way a US funder names the same thing.
 *
 * Deliberately NOT included: `callsign` / `call sign`, and anything matching "Licensing". Both
 * occur only in arrl.org site navigation ("Call Sign / Name Search", "Licensing Classes") on the
 * five ARRL org-grant pages, and in austinhams.org's menu ("Become a Ham", "Ham Classes"); adding
 * them produced six false positives whose only cure would have been six allow-list entries saying
 * "this is a nav menu", which is noise, not review.
 */
const LICENCE_MENTION = new RegExp(
  [
    String.raw`\b(?:amateur[- ]radio|ham(?:[- ]radio)?)\s+licen[sc]e`,
    String.raw`\blicen[sc]ed\s+(?:radio\s+)?(?:amateur|ham)`,
    String.raw`\bamateur[- ]radio\s+operators?\b`,
    String.raw`\blicen[sc]e\s+class\b`,
    String.raw`\bclass\s+of\s+(?:active\s+)?(?:amateur[- ]radio\s+)?licen[sc]e\b`,
    String.raw`\bLicense Requirement\b`,
    String.raw`\bFCC[- ]issued\b`,
  ].join('|'),
  'i',
);

// ---------------------------------------------------------------- the allow-list

/**
 * Programs that carry NO licence floor and SHOULD NOT. Each entry names the funder's own reason.
 * Adding one is the reviewed decision that an unlicensed applicant may legitimately be shown this
 * program; it is not a way to silence the test.
 */
const NO_FLOOR_BY_DESIGN: ReadonlyMap<string, string> = new Map([
  [
    'arrl-scholarship-descriptions::The North Fulton Amateur Radio League Scholarship',
    'The one genuinely unlicensed-OK award in this corpus: the ARRL catalog value for this entry ' +
      'is literally the bare word "None", and normalize/axes/license.ts\'s NO_LICENSE branch ' +
      'exists precisely for it. It publishes a hard licenseMin: NONE — an answer, not a gap.',
  ],
  [
    'arrl-scholarship-program::scholarship-program',
    'The ARRL Foundation PORTAL record, not an award. It is a directory over the 170+ scholarships ' +
      'whose per-award licence rules are the 111 arrl-scholarship-descriptions records, and one of ' +
      'those (North Fulton) genuinely requires no licence — so a corpus-wide floor on the portal ' +
      'would contradict the funder\'s own catalog in the EXCLUDING direction, telling an ' +
      'unlicensed applicant not to look at a list that contains an award for them.',
  ],
  [
    'manual-tier-d::rca-scholarship-program',
    'The Radio Club of America record says so in its own curated text: "A ham licence is NOT ' +
      'required." The trigger here is a NEGATION of a requirement, which is the false positive ' +
      'LICENCE_MENTION knowingly accepts. RCA funds a wireless-career track at ~9 participating ' +
      'schools and the university selects recipients; the student never applies to RCA.',
  ],
  [
    'austin-arc::austin-arc-scholarships',
    'The live capture of austinhams.org/scholarships/ contains no occurrence of the string ' +
      '"licen" at all. The club funds Central-Texas students in engineering, computer science, ' +
      'public service, healthcare "and more", and states no amateur licence rule anywhere. ' +
      'Inventing a TECH floor here would be this codebase guessing against a page it has read.',
  ],
  [
    'sara::sara-student-teacher-grants',
    'SARA\'s $200 student and teacher project grants fund RADIO ASTRONOMY projects, which are ' +
      'receive-only and need no transmitting licence; the Society of Amateur Radio Astronomers ' +
      'says nothing about licensing on its grants page (the capture contains no "licen" string). ' +
      'This is one of exactly two programs the unlicensed high-school profile can reach, and that ' +
      'is correct rather than a leak.',
  ],
  [
    'ncdxf-grants::ncdxf-grant-program',
    'The DXpedition grant page\'s only "licen" string is "the licensing and landing permission", ' +
      'a criterion about the EXPEDITION\'s operating permits in a foreign entity, not about the ' +
      'applicant\'s licence class. NCDXF funds expedition teams and states no applicant licence ' +
      'requirement; the record\'s own notes already say it is not a collegiate program.',
  ],
  [
    'yaesu-dr2x::yaesu-dr2x-repeater-program',
    'A hardware discount on a repeater, not a personal award. The captured page\'s only "licen" ' +
      'strings are the GPL and MIT notices in its own theme CSS/JS headers. The real obligation ' +
      'the programme does impose — twelve months of on-air service — is modelled as an Obligation ' +
      'in OBLIGATIONS_BY_SOURCE, not as an eligibility axis.',
  ],
]);

/**
 * Programs that carry no licence floor and SHOULD. These are not exemptions; they are this
 * invariant's first catch beyond the instance it was written for, recorded so they are tracked
 * rather than rediscovered. An entry moving out of this map is progress; an entry moving into it
 * is a decision somebody has to defend.
 *
 * All three are the SAME second-order defect, and it is not in this change's blast radius: the
 * fix is in normalize/axes/preference.ts or normalize/axes/license.ts — splitting a sentence that
 * states a requirement AND a preference so the requirement half stays hard — and it would move
 * both figures the current remediation contract pins (the ARRL catalog's licence distribution,
 * and the two programs the unlicensed high-school profile can see, one of which is Holt). Doing it
 * blind, in a change about a different source, is how the next wrong award gets published.
 */
const NO_FLOOR_KNOWN_DEFECTS: ReadonlyMap<string, string> = new Map([
  [
    'arrl-scholarship-descriptions::The Michael Holt, K8MJH, and Mary Holt, KC8OIP, Scholarship',
    'DEFECT (requirement and preference in one sentence). "Any active Amateur Radio License Class ' +
      'for two years, preference for General Class" parses to the right spec — licenseMin GENERAL, ' +
      'heldMonthsMin 24 — but isPreferenceText fires on "preference" and softens the WHOLE ' +
      'constraint, so matcher.ts never excludes on it and an unlicensed applicant is shown this ' +
      'award as eligible. The hard half ("Any active Amateur Radio License Class for two years") ' +
      'is a requirement the funder stated plainly.',
  ],
  [
    'arrl-scholarship-descriptions::The New England Amateur Radio Festival (NEAR-Fest) Memorial Scholarship',
    'DEFECT, same shape. "First Preference given to Extra Class … Third Preference Given to ' +
      'Technician Class. Applicants MUST HAVE HELD an amateur radio license for a minimum of one ' +
      'year prior to date of application." Two sentences, one hard and one soft, captured as one ' +
      'field and softened wholesale by the leading preferences.',
  ],
  [
    'arrl-scholarship-descriptions::The Carole J. Streeter, KB9JBR, Scholarship',
    'DEFECT, same shape. "Any class of active Amateur Radio license with preference for basic ' +
      'Morse code capability" — an unconditional licence requirement carrying a preference on a ' +
      'DIFFERENT axis (Morse capability), which softens the licence constraint it is attached to.',
  ],
]);

const ALLOWED = new Set([...NO_FLOOR_BY_DESIGN.keys(), ...NO_FLOOR_KNOWN_DEFECTS.keys()]);

// ---------------------------------------------------------------- the invariant

describe('licence floors: no program may state a licence requirement and then not impose one', () => {
  it('RULE A — every program whose own text plainly states an amateur radio licence carries a hard floor', async () => {
    const { programs } = await corpus();
    const offenders: string[] = [];
    for (const program of programs) {
      if (licenceFloorOf(program) !== undefined) continue;
      const surface = textSurfaceOf(program);
      const hit = LICENCE_MENTION.exec(surface);
      if (hit === null) continue;
      const key = keyOf(program);
      if (ALLOWED.has(key)) continue;
      const quote = surface
        .slice(Math.max(0, hit.index - 70), hit.index + 110)
        .replace(/\s+/g, ' ')
        .trim();
      offenders.push(
        `${key} (${program.name}) states an amateur radio licence — "…${quote}…" — but imposes ` +
          'NO hard licence floor, so an applicant with no amateur licence is not excluded. ' +
          'Either file the sentence under the `license` rawField so extractLicense reads it, or ' +
          'add the program to NO_FLOOR_BY_DESIGN / NO_FLOOR_KNOWN_DEFECTS in ' +
          'licenseFloorContract.test.ts with a reason.',
      );
    }
    expect(offenders).toEqual([]);
  });

  it('RULE B — every individual-facing program without a licence floor is a reviewed statement', async () => {
    const { programs } = await corpus();
    const offenders: string[] = [];
    for (const program of programs) {
      if (!program.applicantEntities.includes('individual')) continue;
      if (licenceFloorOf(program) !== undefined) continue;
      const key = keyOf(program);
      if (ALLOWED.has(key)) continue;
      offenders.push(
        `${key} (${program.name}) accepts an individual applicant and imposes NO hard licence ` +
          'floor. If that is right, say so in NO_FLOOR_BY_DESIGN / NO_FLOOR_KNOWN_DEFECTS in ' +
          'licenseFloorContract.test.ts with a reason; if it is not, the licence sentence is ' +
          'being filed under a rawField extractLicense does not read.',
      );
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the allow-list honest: every listed program still exists and still has no floor', async () => {
    const { programs } = await corpus();
    const byKey = new Map(programs.map((p) => [keyOf(p), p]));
    // A listed program that has vanished, or that has since GAINED a floor, is dead documentation —
    // and dead documentation is how the next reader learns to stop trusting the list.
    const stale = [...ALLOWED]
      .filter((key) => byKey.get(key) === undefined || licenceFloorOf(byKey.get(key) as Program) !== undefined)
      .sort();
    expect(stale).toEqual([]);
  });

  it('gives every listed program a real reason and never lists one twice', () => {
    for (const [key, reason] of [...NO_FLOOR_BY_DESIGN, ...NO_FLOOR_KNOWN_DEFECTS]) {
      expect(reason.length, `${key} needs a real reason, not a placeholder`).toBeGreaterThan(80);
    }
    const both = [...NO_FLOOR_BY_DESIGN.keys()].filter((k) => NO_FLOOR_KNOWN_DEFECTS.has(k));
    expect(both).toEqual([]);
  });
});

// ---------------------------------------------------------------- the instance

describe('the instance this audit was written for', () => {
  it('NCDXF W6EEN publishes a hard TECH floor read off its own captured page', async () => {
    const { programs } = await corpus();
    const ncdxf = programs.find((p) => keyOf(p) === 'ncdxf-scholarships::ncdxf-w6een-scholarship');
    if (ncdxf === undefined) throw new Error('ncdxf-w6een-scholarship is missing from the corpus');
    expect(licenceFloorOf(ncdxf)).toBe('TECH');
    // "No restriction as to CLASS of license" is ANY CLASS QUALIFIES, never "no licence needed":
    // it presupposes a licence and disclaims only a floor above the entry level.
    const licence = ncdxf.constraints.filter((c) => c.spec.axis === 'license');
    expect(licence).toHaveLength(1);
    expect(licence[0].rawText).toBe('There is no restriction as to class of license.');
    expect(licence[0].spec).toEqual({ axis: 'license', licenseMin: 'TECH' });
  });
});

// ---------------------------------------------------------------- self-check

/**
 * A detector that silently stops matching, or a corpus that silently stops loading, would make
 * every assertion above pass while checking nothing — the failure mode `sources/registry.test.ts`
 * calls "a gate that checks nothing". These pin both halves.
 *
 * The five sentences below are the verbatim text of the five real defects of this class. Four are
 * already fixed at source (tier-c-a.ts now files them under `license`), so the corpus no longer
 * flags them — which is exactly why they are re-proved here against the DETECTOR rather than
 * against the corpus. A regression in any of those four sources would land the sentence back on
 * the text surface, and these assertions are the evidence that it would then be seen.
 */
describe('the licence detector actually sees the class', () => {
  const HISTORICAL_DEFECT_SENTENCES: ReadonlyArray<[string, string]> = [
    ['qcwa (1/5)', 'Applications are requested by interested licensed radio amateurs.'],
    ['qcwa (1/5), second statement', 'Scholarships are awarded to worthy Amateur Radio operators enrolled in accredited colleges or universities.'],
    ['ylrl x3 (2-4/5)', 'Applicant must have an Amateur Radio License.'],
    ['ncdxf-scholarships (5/5)', 'There is no restriction as to class of license.'],
    ['ncdxf-scholarships (5/5), second statement', 'If you are a licensed amateur radio operator 25 years of age or younger, you can apply for a free tuition scholarship.'],
    ['the ARRL catalog label', 'License Requirement: Any active Amateur Radio License Class for two years, preference for General Class'],
  ];

  it('fires on every sentence that produced a real wrong award', () => {
    for (const [where, sentence] of HISTORICAL_DEFECT_SENTENCES) {
      expect(LICENCE_MENTION.test(sentence), `${where}: "${sentence}"`).toBe(true);
    }
  });

  it('does not fire on the site navigation that shares its vocabulary', () => {
    // Real chrome from the captured pages. Each of these once produced a false positive and is
    // the reason `callsign` and `Licensing` are not triggers.
    for (const chrome of [
      'Exam Sessions Hamfest/Conventions Licensing Classes Member Directory Call Sign / Name Search',
      'Learn Become a Ham Ham Classes Technical Resources Useful Links Newsletter Archive',
      'the operating plans, the licensing and landing permission, the amount of time planned',
      'community connections (ham radio groups or other community members who could be of assistance)',
    ]) {
      expect(LICENCE_MENTION.test(chrome), chrome).toBe(false);
    }
  });

  it('treats a soft or NONE licence constraint as no floor at all', () => {
    const base = {
      constraints: [] as Program['constraints'],
    } as unknown as Program;
    const withSpec = (hard: boolean, licenseMin: 'TECH' | 'NONE'): Program => ({
      ...base,
      constraints: [
        { id: 'l', hard, fallbackRank: 0, rawText: 'x', spec: { axis: 'license', licenseMin } },
      ],
    });
    expect(licenceFloorOf(withSpec(true, 'TECH'))).toBe('TECH');
    expect(licenceFloorOf(withSpec(false, 'TECH'))).toBeUndefined();
    expect(licenceFloorOf(withSpec(true, 'NONE'))).toBeUndefined();
    expect(licenceFloorOf(base)).toBeUndefined();
  });

  it('reads a corpus that is actually populated, and finds licence floors in it', async () => {
    const { programs } = await corpus();
    expect(programs.length).toBeGreaterThan(150);
    const withFloor = programs.filter((p) => licenceFloorOf(p) !== undefined);
    // The ARRL catalog alone contributes over a hundred; a corpus that stopped parsing, or a
    // predicate that stopped recognising the axis, would collapse this to nothing.
    expect(withFloor.length).toBeGreaterThan(100);
    expect(new Set(withFloor.map((p) => licenceFloorOf(p)))).toEqual(new Set(['TECH', 'GENERAL']));
  });

  it('scans a surface that includes the field the NCDXF sentence was hiding in', async () => {
    const { programs } = await corpus();
    const ncdxf = programs.find((p) => keyOf(p) === 'ncdxf-scholarships::ncdxf-w6een-scholarship');
    if (ncdxf === undefined) throw new Error('ncdxf-w6een-scholarship is missing from the corpus');
    // `applyContact` is rawFields.applyNote — where "If you are a licensed amateur radio
    // operator…" lives. If textSurfaceOf ever stopped reading it, the detector would go blind to
    // the exact hiding place this audit was written for.
    expect(ncdxf.applyContact).toMatch(/If you are a licensed amateur radio operator/);
    expect(textSurfaceOf(ncdxf)).toContain(ncdxf.applyContact as string);
    expect(textSurfaceOf(ncdxf)).toContain(ncdxf.rawOtherText);
  });
});
