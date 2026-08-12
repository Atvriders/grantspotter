import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Program } from '@grantspotter/core';
import { evaluateConstraint } from '@grantspotter/core';
import { describe, expect, it } from 'vitest';
// The offline corpus loader: every committed REAL capture, parsed by its own source module and
// normalized exactly as the crawler does, minus the records `buildReviewItems` suppresses. Shared
// with `scripts/profile-corpus.ts` and with `packages/core/test/matcher.test.ts` rather than
// reimplemented, so this audit and the profiler can never disagree about what "the corpus" is.
import { loadCorpus } from '../../../../scripts/profile-corpus.js';
import { SOURCES } from '../sources/registry.js';
import { FIXTURE_ROOT } from '../../test/fixtures.js';

/** Fixed clock and the whole state list, for the "…and it still refuses nobody" checks below. */
const NOW = '2026-08-02T00:00:00.000Z';
const ALL_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA',
  'ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR',
  'PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY',
];

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
 * WHY EACH EXEMPTION CARRIES EVIDENCE AND NOT ONLY PROSE (close-out review, cross-cutting).
 *
 * Every allow-list in this repo used to be gated by a STRING-LENGTH check on its reason —
 * `expect(reason.length).toBeGreaterThan(80)` was this file's. That is not a guard. It is
 * satisfied by eighty characters of anything, it cannot tell a true reason from a false one, and
 * it goes on passing forever after the fact it describes has stopped being true. This project has
 * already been burned twice by exactly that shape: an invariant that failed open, and 18 tracked
 * defects that read as coverage.
 *
 * So every entry below now states its reason in a form the test EXECUTES. The prose stays, because
 * a human still has to read it, but the prose is documentation and the `evidence` is the guard. If
 * austinhams.org publishes a licence rule tomorrow, or the Yaesu page grows a licence sentence
 * outside its theme's GPL header, or North Fulton stops publishing its explicit `NONE`, the entry
 * fails and names itself — instead of sitting here asserting something nobody rechecked.
 *
 * The kinds are deliberately few, and each is a claim about something committed to this repo:
 */
type Evidence =
  /**
   * The record publishes an ANSWER, not a gap: a hard `license` constraint whose `licenseMin` is
   * `NONE`, read off the funder's own stated value. `licenceFloorOf` treats that as "no floor" on
   * purpose (it is functionally identical for a matcher), which is exactly why it needs an entry
   * here — and why the entry must prove the answer is still being published.
   */
  | { readonly kind: 'publishes_an_explicit_no_licence_answer'; readonly rawText: string }
  /**
   * The funder's committed capture never says "licen" at all, so any floor this codebase imposed
   * would be invented rather than read. Fails if the page starts talking about licences — which is
   * the whole point, since RULE A cannot fire on a record with no floor and no trigger text.
   */
  | { readonly kind: 'capture_never_mentions_a_licence' }
  /**
   * The capture DOES say "licen", but only in contexts that are not an applicant licence rule.
   * Every occurrence must land in one of the named contexts, and every named context must still
   * match something — so neither a new sentence nor a deleted one leaves the entry unexamined.
   */
  | { readonly kind: 'capture_mentions_licence_only_as'; readonly contexts: readonly string[] }
  /** The record's own published text says, verbatim, that no licence is required. */
  | { readonly kind: 'record_text_states'; readonly phrase: string }
  /**
   * A PORTAL record, whose licence rules are its catalogue's. The claim "one of the awards behind
   * this portal genuinely requires no licence, so a floor here would exclude in the wrong
   * direction" is checkable: the catalogue must still publish at least one award with an explicit
   * `NONE`. If the catalogue ever stops, this exemption's reasoning has evaporated and it says so.
   */
  | { readonly kind: 'catalogue_contains_an_unlicensed_award'; readonly catalogueSourceId: string };

interface Exemption {
  readonly reason: string;
  readonly evidence: Evidence;
}

/** The committed REAL captures for a source — the `NN-` files `loadCorpus` itself feeds the parser. */
function realCaptures(sourceId: string): Array<{ file: string; body: string }> {
  const dir = path.join(FIXTURE_ROOT, sourceId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d\d-/.test(f))
    .sort()
    .map((file) => ({ file, body: readFileSync(path.join(dir, file), 'utf8') }));
}

/** Every "licen" occurrence in a captured page, with enough of its neighbourhood to judge it. */
function licenceWindows(body: string): string[] {
  const out: string[] = [];
  const re = /licen/gi;
  for (let m = re.exec(body); m !== null; m = re.exec(body)) {
    out.push(body.slice(Math.max(0, m.index - 70), m.index + 70).replace(/\s+/g, ' '));
  }
  return out;
}

/**
 * Programs that carry NO licence floor and SHOULD NOT. Each entry names the funder's own reason
 * AND the evidence for it. Adding one is the reviewed decision that an unlicensed applicant may
 * legitimately be shown this program; it is not a way to silence the test, and an entry whose
 * evidence stops holding fails rather than lingering.
 */
const NO_FLOOR_BY_DESIGN: ReadonlyMap<string, Exemption> = new Map([
  [
    'arrl-scholarship-descriptions::The North Fulton Amateur Radio League Scholarship',
    {
      reason:
        'The one genuinely unlicensed-OK award in this corpus: the ARRL catalog value for this ' +
        'entry is literally the bare word "None", and normalize/axes/license.ts\'s NO_LICENSE ' +
        'branch exists precisely for it. It publishes a hard licenseMin: NONE — an answer, not a gap.',
      evidence: { kind: 'publishes_an_explicit_no_licence_answer', rawText: 'None' },
    },
  ],
  [
    'arrl-scholarship-program::scholarship-program',
    {
      reason:
        'The ARRL Foundation PORTAL record, not an award. It is a directory over the 170+ ' +
        'scholarships whose per-award licence rules are the 111 arrl-scholarship-descriptions ' +
        'records, and one of those (North Fulton) genuinely requires no licence — so a ' +
        'corpus-wide floor on the portal would contradict the funder\'s own catalog in the ' +
        'EXCLUDING direction, telling an unlicensed applicant not to look at a list that ' +
        'contains an award for them.',
      evidence: {
        kind: 'catalogue_contains_an_unlicensed_award',
        catalogueSourceId: 'arrl-scholarship-descriptions',
      },
    },
  ],
  [
    'manual-tier-d::rca-scholarship-program',
    {
      reason:
        'The Radio Club of America record says so in its own curated text: "A ham licence is NOT ' +
        'required." The trigger here is a NEGATION of a requirement, which is the false positive ' +
        'LICENCE_MENTION knowingly accepts. RCA funds a wireless-career track at ~9 participating ' +
        'schools and the university selects recipients; the student never applies to RCA.',
      evidence: { kind: 'record_text_states', phrase: 'A ham licence is NOT required.' },
    },
  ],
  [
    'austin-arc::austin-arc-scholarships',
    {
      reason:
        'The live capture of austinhams.org/scholarships/ contains no occurrence of the string ' +
        '"licen" at all. The club funds Central-Texas students in engineering, computer science, ' +
        'public service, healthcare "and more", and states no amateur licence rule anywhere. ' +
        'Inventing a TECH floor here would be this codebase guessing against a page it has read.',
      evidence: { kind: 'capture_never_mentions_a_licence' },
    },
  ],
  [
    'sara::sara-student-teacher-grants',
    {
      reason:
        'SARA\'s $200 student and teacher project grants fund RADIO ASTRONOMY projects, which are ' +
        'receive-only and need no transmitting licence; the Society of Amateur Radio Astronomers ' +
        'says nothing about licensing on its grants page (the capture contains no "licen" string). ' +
        'This is one of exactly two programs the unlicensed high-school profile can reach, and ' +
        'that is correct rather than a leak.',
      evidence: { kind: 'capture_never_mentions_a_licence' },
    },
  ],
  [
    'ncdxf-grants::ncdxf-grant-program',
    {
      reason:
        'The DXpedition grant page\'s only "licen" string is "the licensing and landing ' +
        'permission", a criterion about the EXPEDITION\'s operating permits in a foreign entity, ' +
        'not about the applicant\'s licence class. NCDXF funds expedition teams and states no ' +
        'applicant licence requirement; the record\'s own notes already say it is not a ' +
        'collegiate program.',
      evidence: {
        kind: 'capture_mentions_licence_only_as',
        contexts: ['the licensing and landing permission'],
      },
    },
  ],
  [
    'yaesu-dr2x::yaesu-dr2x-repeater-program',
    {
      reason:
        'A hardware discount on a repeater, not a personal award. The captured page\'s only ' +
        '"licen" strings are the GPL and MIT notices in its own theme CSS/JS headers. The real ' +
        'obligation the programme does impose — twelve months of on-air service — is modelled as ' +
        'an Obligation in OBLIGATIONS_BY_SOURCE, not as an eligibility axis.',
      evidence: {
        kind: 'capture_mentions_licence_only_as',
        // Divi's GPL v2 theme header (4 hits) and Animate.css's MIT notice (3 hits). Both are
        // software licences in a <style> block, which is why "licen" on this page proves nothing
        // about who may apply.
        contexts: ['GNU General Public License', 'Licensed under the MIT license'],
      },
    },
  ],
]);

/**
 * Runs one entry's evidence and returns the reason it no longer holds, or `undefined`.
 *
 * The source id is derived from the key rather than restated in the entry: `source::externalKey`
 * IS the ingest identity, so an entry can never name one source and check another's fixtures.
 */
function evidenceFailure(
  key: string,
  entry: Exemption,
  program: Program | undefined,
  programs: readonly Program[],
): string | undefined {
  const sourceId = key.slice(0, key.indexOf('::'));
  const { evidence } = entry;
  switch (evidence.kind) {
    case 'publishes_an_explicit_no_licence_answer': {
      if (program === undefined) return `${key}: not in the corpus, so its evidence cannot be read`;
      const answer = program.constraints.find(
        (c) => c.spec.axis === 'license' && c.hard && c.spec.licenseMin === 'NONE',
      );
      if (answer === undefined) {
        return (
          `${key} claims it publishes an explicit "no licence required" ANSWER, but it now ` +
          'carries no hard license constraint with licenseMin NONE at all. A gap is not an ' +
          'answer: this is now an ordinary missing floor and the exemption no longer applies.'
        );
      }
      if (answer.rawText.trim() !== evidence.rawText) {
        return (
          `${key} publishes licenseMin NONE read off ${JSON.stringify(answer.rawText)}, but the ` +
          `entry was signed against ${JSON.stringify(evidence.rawText)}. Re-read the funder's ` +
          'page: the value the answer was derived from has changed.'
        );
      }
      return undefined;
    }
    case 'capture_never_mentions_a_licence': {
      const captures = realCaptures(sourceId);
      if (captures.length === 0) {
        return (
          `${key}: no committed NN-* capture for "${sourceId}", so "the page never mentions a ` +
          'licence" is being asserted about a page nothing here can read.'
        );
      }
      const talking = captures
        .map((c) => ({ file: c.file, windows: licenceWindows(c.body) }))
        .filter((c) => c.windows.length > 0);
      if (talking.length === 0) return undefined;
      return (
        `${key} is exempt because its capture never says "licen" — it now does, ` +
        `${talking.map((t) => `${t.file}: ${t.windows.length}`).join(', ')}. First: ` +
        `"…${talking[0].windows[0]}…". Re-read the page and either impose the floor or ` +
        're-sign this entry with the context it appears in.'
      );
    }
    case 'capture_mentions_licence_only_as': {
      const captures = realCaptures(sourceId);
      if (captures.length === 0) {
        return `${key}: no committed NN-* capture for "${sourceId}" to check the contexts against.`;
      }
      const windows = captures.flatMap((c) => licenceWindows(c.body));
      if (windows.length === 0) {
        return (
          `${key} names the contexts its capture's "licen" strings appear in, but the capture ` +
          'now contains none at all. The evidence is stale — use ' +
          'capture_never_mentions_a_licence, or recapture the page.'
        );
      }
      const unexplained = windows.filter((w) => !evidence.contexts.some((c) => w.includes(c)));
      if (unexplained.length > 0) {
        return (
          `${key} is exempt because every "licen" on its page is one of ` +
          `${JSON.stringify(evidence.contexts)} — ${unexplained.length} occurrence(s) now are ` +
          `not. First: "…${unexplained[0]}…".`
        );
      }
      const dead = evidence.contexts.filter((c) => !windows.some((w) => w.includes(c)));
      if (dead.length > 0) {
        return (
          `${key} lists context(s) ${JSON.stringify(dead)} that no longer appear on the captured ` +
          'page. A context that matches nothing is dead documentation and the next reader learns ' +
          'to stop trusting the list.'
        );
      }
      return undefined;
    }
    case 'record_text_states': {
      if (program === undefined) return `${key}: not in the corpus, so its evidence cannot be read`;
      if (textSurfaceOf(program).includes(evidence.phrase)) return undefined;
      return (
        `${key} is exempt because its own published text says ` +
        `${JSON.stringify(evidence.phrase)}. It no longer does. The record can no longer be ` +
        'cited as saying a licence is not required.'
      );
    }
    case 'catalogue_contains_an_unlicensed_award': {
      const catalogue = programs.filter((p) => keyOf(p).startsWith(`${evidence.catalogueSourceId}::`));
      if (catalogue.length === 0) {
        return (
          `${key} defers to the "${evidence.catalogueSourceId}" catalogue, which produced NO ` +
          'programs at all — so the reasoning behind this exemption cannot be checked.'
        );
      }
      const unlicensed = catalogue.filter((p) =>
        p.constraints.some((c) => c.spec.axis === 'license' && c.hard && c.spec.licenseMin === 'NONE'),
      );
      if (unlicensed.length > 0) return undefined;
      return (
        `${key} is exempt because at least one award in the "${evidence.catalogueSourceId}" ` +
        `catalogue genuinely requires no licence. None of its ${String(catalogue.length)} awards ` +
        'does any more, so a floor on the portal would no longer exclude anybody wrongly — ' +
        'delete this exemption and let RULE B impose one.'
      );
    }
  }
}

/**
 * Programs that carry no licence floor and SHOULD. These are not exemptions; they are this
 * invariant's first catch beyond the instance it was written for, recorded so they are tracked
 * rather than rediscovered. An entry moving out of this map is progress; an entry moving into it
 * is a decision somebody has to defend.
 *
 * EMPTY AS OF THE PREFERENCE-SCOPE FIX. It held three entries — Holt, NEAR-Fest and Carole
 * Streeter — which were one defect three times: `isPreferenceText` softened a WHOLE captured
 * field whenever preference language appeared anywhere in it, so a field stating a requirement
 * AND a preference lost the requirement half, and `matcher.ts` never excludes on a soft
 * constraint. `normalize/axes/preference.ts` now scopes the softening to the clause carrying the
 * preference, and `extractLicense` reads the class off `requirementText` so the FLOOR is what the
 * funder requires rather than what it prefers. All three now publish a hard floor and are pinned
 * by name in "the three the allow-list used to hold" below.
 *
 * Holt is why this mattered rather than being tidy. It was one of the two programs the unlicensed
 * high-school profile could reach, and that figure of 2 was being read as evidence that licence
 * enforcement worked. It was the opposite: Holt requires an active amateur licence held for two
 * years, and the profile was showing it to an applicant with no licence at all. The figure is now
 * 1 — SARA's $200 radio-astronomy grant, which genuinely requires no licence.
 *
 * Kept as an empty map rather than deleted: it is the shape of the next finding of this kind, and
 * the sentence above it is the record of what belongs in it.
 */
const NO_FLOOR_KNOWN_DEFECTS: ReadonlyMap<string, string> = new Map([]);

const ALLOWED = new Set([...NO_FLOOR_BY_DESIGN.keys(), ...NO_FLOOR_KNOWN_DEFECTS.keys()]);

/**
 * THE OTHER WAY THIS AUDIT GOES QUIET: A SOURCE LEAVING THE POPULATION.
 *
 * RULE A and RULE B scan `loadCorpus()`. `loadCorpus` does not fail when a source cannot be
 * loaded — it SKIPS it and records a `why`, because the profiler it was written for would rather
 * report 25 sources than nothing. Nothing here read that list, so a source whose fixture was moved,
 * whose `requests()` threw, or whose parser started throwing simply left the audited population and
 * every programme it publishes escaped both rules, silently and permanently.
 *
 * MEASURED, before this guard existed: hiding the committed captures for `qcwa` and `ylrl` — two
 * of the three sources whose historical wrong awards this whole file exists to prevent — dropped
 * five programmes out of the corpus and **all 15 tests in this file stayed green**. The old
 * vacuity guard (`loaded.length >= 20`, against 26) had 6 sources of headroom by construction and
 * could not see it.
 *
 * So a source producing no audited records is now a FAILURE unless it is listed here, and each
 * entry carries the EXACT `why` string `loadCorpus` reports — machine-checkable, not prose. The
 * list is guarded in both directions: an entry that starts loading again, or that starts skipping
 * for a different reason, fails just as loudly as an unlisted source that disappears.
 */
const NOT_IN_THE_AUDITED_POPULATION: ReadonlyMap<string, { why: string; reason: string }> = new Map([
  [
    'arrl-news-rss',
    {
      // Verbatim from `loadCorpus`, which derives it from `isSignalSource(source)`.
      why: 'signal-only source: produces change events, not candidates',
      reason:
        'The ARRL news feed is a SIGNAL source: it emits ChangeEvents so a human notices a funder ' +
        'announcement, and produces no candidate programme at all (runner.test.ts pins "emits ' +
        'ChangeEvents for relevant items and NO review items"). There is nothing for a licence ' +
        'floor to be missing from — it publishes no record any applicant can be shown.',
    },
  ],
]);

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

  /**
   * THE GUARD THAT REPLACED `reason.length > 80`.
   *
   * A length check is satisfied by padding and proves nothing; this runs each entry's stated
   * reason against the committed captures and the loaded corpus, so an exemption whose premise has
   * stopped being true fails and names itself. Every kind is defined at `Evidence` above with the
   * failure it is meant to catch.
   */
  it('every by-design exemption still has the evidence it was signed with', async () => {
    const { programs } = await corpus();
    const byKey = new Map(programs.map((p) => [keyOf(p), p]));
    const failures: string[] = [];
    for (const [key, entry] of NO_FLOOR_BY_DESIGN) {
      const failure = evidenceFailure(key, entry, byKey.get(key), programs);
      if (failure !== undefined) failures.push(failure);
    }
    expect(failures).toEqual([]);
  });

  it('never lists the same program as both by-design and a known defect', () => {
    const both = [...NO_FLOOR_BY_DESIGN.keys()].filter((k) => NO_FLOOR_KNOWN_DEFECTS.has(k));
    expect(both).toEqual([]);
  });

  /**
   * VACUITY GUARD FOR THE EVIDENCE ITSELF. Every kind defined above must actually be exercised by
   * a live entry — otherwise a kind could rot into a no-op (or be quietly narrowed) and no entry
   * would notice, which is the same "a gate that checks nothing" failure the evidence exists to
   * end. Read as: these are the four shapes of proof this list currently rests on.
   */
  it('exercises every evidence kind it defines', () => {
    const used = new Set([...NO_FLOOR_BY_DESIGN.values()].map((e) => e.evidence.kind));
    expect([...used].sort()).toEqual([
      'capture_mentions_licence_only_as',
      'capture_never_mentions_a_licence',
      'catalogue_contains_an_unlicensed_award',
      'publishes_an_explicit_no_licence_answer',
      'record_text_states',
    ]);
  });
});

/**
 * A TRACKED DEFECT MAY NEVER BE GREEN HERE.
 *
 * `NO_FLOOR_KNOWN_DEFECTS` is empty today, and this is the guard that keeps adding to it a
 * deliberate, visible act. The close-out review's cross-cutting finding was that the sibling
 * `WRITE_ONLY_KNOWN_DEFECTS` holds 19 entries, every one labelled "DEFECT", every one reported as
 * a passing test — and that the resulting green count was being cited as a health signal. An entry
 * in this map means a program this product SHOWS to an applicant it should not; it is outstanding
 * work, and outstanding work that reports as passing is how a defect becomes documentation.
 *
 * So the map cannot quietly gain a member. Anything added has to be emitted as `it.todo` — which
 * prints on every run and is counted separately from passing — and signed in
 * `packages/server/test/vitestCoverageContract.test.ts`'s `SKIPPED_BY_DESIGN`, which is the
 * repo-wide invariant that no statically skipped block goes unexplained. Both of those are
 * deliberate acts by whoever records the defect; this assertion is what makes them unavoidable.
 */
it('has no tracked licence-floor defect quietly reporting as a pass', () => {
  expect(
    [...NO_FLOOR_KNOWN_DEFECTS.keys()],
    'a program in NO_FLOOR_KNOWN_DEFECTS is shown to applicants it should exclude. Do not leave ' +
      'it here as a silently-passing allow-list entry: emit it as `it.todo` so it prints on every ' +
      'run as outstanding, and sign that skip in vitestCoverageContract.test.ts SKIPPED_BY_DESIGN.',
  ).toEqual([]);
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

// ---------------------------------------------------------------- the three the allow-list held

/**
 * ONE DEFECT, THREE TIMES: a captured field that states a requirement AND a preference, softened
 * whole. `NO_FLOOR_KNOWN_DEFECTS` carried these three for exactly this reason and is now empty.
 *
 * Each assertion below is the funder's own captured wording turned into a number, so a future
 * change to `preference.ts` that re-widens the softening fails here by name rather than by moving
 * an aggregate somebody has to go and re-derive. Both halves are pinned deliberately: the
 * requirement that must be HARD, and the preference that must stay SOFT. A fix that hardened
 * everything would pass a floors-only test while converting every stated preference into a bar.
 */
function constraintsOn(program: Program, axis: string): Program['constraints'] {
  return program.constraints.filter((c) => c.spec.axis === axis);
}

async function programNamed(key: string): Promise<Program> {
  const { programs } = await corpus();
  const found = programs.find((p) => keyOf(p) === key);
  if (found === undefined) throw new Error(`${key} is missing from the corpus`);
  return found;
}

describe('requirement-and-preference in one field: the requirement half survives', () => {
  it('Holt — "Any active Amateur Radio License Class for two years, preference for General Class"', async () => {
    const holt = await programNamed(
      'arrl-scholarship-descriptions::The Michael Holt, K8MJH, and Mary Holt, KC8OIP, Scholarship',
    );
    const licence = constraintsOn(holt, 'license');
    expect(licence).toHaveLength(1);
    expect(licence[0].rawText).toBe(
      'Any active Amateur Radio License Class for two years, preference for General Class',
    );
    // HARD, and the floor is the REQUIRED class, not the preferred one. "Any active Amateur Radio
    // License Class for two years" names no class, so the floor is the entry-level TECH; General
    // is a preference and preferences do not exclude. Publishing GENERAL here would bar the
    // Technician-of-two-years this funder plainly accepts — the opposite error, equally wrong.
    expect(licence[0].hard).toBe(true);
    expect(licence[0].spec).toEqual({ axis: 'license', licenseMin: 'TECH', heldMonthsMin: 24 });
    expect(licenceFloorOf(holt)).toBe('TECH');
    // …and the Engineering PREFERENCE on the other axis of the same record stays soft. This is
    // the pair that makes the fix a scoping fix rather than a hardening one.
    const field = constraintsOn(holt, 'field_of_study');
    expect(field).toHaveLength(1);
    expect(field[0].rawText).toBe('Preference for an Engineering discipline');
    expect(field[0].hard).toBe(false);
  });

  it('NEAR-Fest — a preference cascade and a "must have held" sentence in one field', async () => {
    const nearFest = await programNamed(
      'arrl-scholarship-descriptions::The New England Amateur Radio Festival (NEAR-Fest) Memorial Scholarship',
    );
    const licence = constraintsOn(nearFest, 'license');
    expect(licence).toHaveLength(1);
    expect(licence[0].rawText).toBe(
      'First Preference given to Extra Class, Second Preference given to General Class, Third ' +
        'Preference Given to Technician Class. Applicants must have held an amateur radio license ' +
        'for a minimum of one year prior to date of application.',
    );
    // The ranking is genuinely a preference; "Applicants must have held…" is genuinely a
    // requirement, and it is a whole sentence of its own — which is why the softening must stop
    // at the sentence boundary. TECH is the lowest class the cascade names, i.e. the floor, and
    // the year of tenure comes from the required sentence.
    expect(licence[0].hard).toBe(true);
    expect(licence[0].spec).toEqual({ axis: 'license', licenseMin: 'TECH', heldMonthsMin: 12 });
    expect(licenceFloorOf(nearFest)).toBe('TECH');
  });

  it('Carole Streeter — a licence requirement carrying a preference on a DIFFERENT axis', async () => {
    const streeter = await programNamed(
      'arrl-scholarship-descriptions::The Carole J. Streeter, KB9JBR, Scholarship',
    );
    const licence = constraintsOn(streeter, 'license');
    expect(licence).toHaveLength(1);
    expect(licence[0].rawText).toBe(
      'Any class of active Amateur Radio license with preference for basic Morse code capability',
    );
    // "Any class of active Amateur Radio license" is unconditional. The Morse preference is about
    // an operating skill, not a licence class, and softened a licence requirement it only happens
    // to share a field with.
    expect(licence[0].hard).toBe(true);
    expect(licence[0].spec).toEqual({ axis: 'license', licenseMin: 'TECH' });
    expect(licenceFloorOf(streeter)).toBe('TECH');
  });

  it('the Louisiana cascade is still SOFT — a preference is not a bar', async () => {
    // Walter Gallinghouse, K5DSL. The funder says in its own words that a non-Louisiana applicant
    // can win this, so nothing in the sentence is a requirement however it is punctuated. This is
    // the over-hardening direction, and it is the one a scoping fix is most likely to break.
    const gallinghouse = await programNamed(
      'arrl-scholarship-descriptions::The Walter Gallinghouse, K5DSL, Scholarship',
    );
    const geo = constraintsOn(gallinghouse, 'geography');
    const text =
      'Preference will be given to applicants residing in Louisiana. If no qualified applicant is ' +
      'identified, the scholarship may be awarded to an applicant from the Delta Division ' +
      '(Arkansas, Louisiana, Mississippi, Tennessee).';
    expect(geo[0].rawText).toBe(text);
    expect(geo[0].hard).toBe(false);
    expect(geo[0].fallbackRank).toBe(1);

    // ROUND 8. The preference above is unchanged; the record now also publishes the LADDER the
    // same sentence states — Louisiana, or failing that the Delta Division — because a soft
    // constraint refuses nobody and was therefore telling an Ohio applicant `eligible`. The claim
    // this test makes has not moved: nothing here is a bar. `orUnrepresented` carries the funder's
    // own condition, and `ConstraintAlternatives` gives it exactly one power, to turn a `fail` into
    // an `unknown` — asserted below over every state rather than taken on trust.
    expect(geo).toHaveLength(2);
    expect(geo[1].hard).toBe(true);
    expect(geo[1].rawText).toBe(text);
    expect(geo[1].spec).toEqual({
      axis: 'geography',
      geo: { type: 'state', values: ['LA'] },
      anyOf: [{ axis: 'geography', geo: { type: 'arrl_division', values: ['Delta'] } }],
      orUnrepresented: 'If no qualified applicant is identified',
    });
    const refused = ALL_STATES.filter(
      (state) =>
        evaluateConstraint(geo[1].spec, { kind: 'student', state }, NOW, geo[1].rawText).status ===
        'fail',
    );
    expect(refused).toEqual([]);
  });

  it('no ARRL catalog award is open to an unlicensed applicant except the one that says so', async () => {
    // RULE B by NAME rather than by membership. Holt sat in this list until now, which is what
    // made the `hs-unlicensed` profiler figure read 2 (Holt and SARA) and be cited as evidence
    // that licence enforcement worked — while Holt's own requirement was the thing being erased.
    // It is 1 now, and SARA's $200 radio-astronomy grants are receive-only and state no licence
    // rule anywhere, so that is a correct answer rather than a regression.
    //
    // Pinned exactly, not as a count: RULE B above only asks whether each entry is on the
    // allow-list, so an entry SILENTLY JOINING the allow-listed set would still pass it.
    const { programs } = await corpus();
    const openToUnlicensed = programs
      .filter((p) => p.applicantEntities.includes('individual'))
      .filter((p) => licenceFloorOf(p) === undefined)
      .map(keyOf)
      .sort();
    expect(openToUnlicensed).toEqual([
      // The one ARRL catalog entry whose stated License Requirement is the bare word "None".
      'arrl-scholarship-descriptions::The North Fulton Amateur Radio League Scholarship',
      'arrl-scholarship-program::scholarship-program',
      'austin-arc::austin-arc-scholarships',
      'ncdxf-grants::ncdxf-grant-program',
      'sara::sara-student-teacher-grants',
      'yaesu-dr2x::yaesu-dr2x-repeater-program',
    ]);
    // Every reason for the six above is in NO_FLOOR_BY_DESIGN; none of them is a catalog award
    // that states a licence rule and fails to impose it.
    expect(openToUnlicensed.every((k) => NO_FLOOR_BY_DESIGN.has(k))).toBe(true);
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

  /**
   * THE VACUITY GUARD — and why it is no longer a number somebody has to lower.
   *
   * This assertion was `expect(programs.length).toBeGreaterThan(150)`, then `>140`. Both were the
   * same instrument: a hand-set floor under the total record count. During this plan alone that
   * total went 178 → 742 → 197 → 152 → 149 as real fixtures landed, as `do_not_publish` was
   * applied to the loader, and as the adjacency gate beside it was applied too. Not one of those
   * moves was a defect, and EVERY one of them moved the number DOWN, so every one of them ended in
   * an edit to this line. A threshold that is only ever lowered converges on asserting nothing —
   * which is precisely the trap `NO_FLOOR_KNOWN_DEFECTS` above documents, where an entry marked
   * "known defect" was simultaneously propping up a metric somebody was reading as evidence.
   *
   * It is also the wrong INSTRUMENT for the thing it guards. What would make RULE A and RULE B
   * vacuous is a source that silently stops producing records: a moved fixture, a parser that
   * throws, a `requests()` list that no longer lines up with the captured files. The ARRL
   * Foundation catalogue is 111 of the 149, so EVERY other source in the registry could go
   * completely silent and a total-count threshold would never notice — the total stays
   * comfortably above any figure a reviewer would dare set. The count cannot see the failure it
   * was written to catch.
   *
   * So the guard now asserts the SHAPE of the load instead, and every claim is scale-free:
   *
   *   1. NO LOADED SOURCE IS SILENT. `loadCorpus` already accounts for all three fates of a
   *      normalized record — published, `do_not_publish`-suppressed, adjacency-gated — so
   *      "produced nothing at all" is expressible without a single magic number, per source. This
   *      is the assertion that actually fails when a fixture moves or a parser breaks, and it does
   *      not move when a funder adds or removes awards.
   *   2. EVERY REGISTERED SOURCE IS IN THE AUDITED POPULATION, or is signed for in
   *      `NOT_IN_THE_AUDITED_POPULATION` with the exact reason `loadCorpus` reports for skipping
   *      it. This is the claim that replaced `loaded.length >= 20`, which had six sources of
   *      headroom and was measured to survive TWO of this file's own three historical sources
   *      vanishing (see the comment on that map). It is an identity, not a threshold: it cannot be
   *      satisfied by lowering anything.
   *   3. THE POPULATION RULE B SCANS IS REAL, stated against the size of this file's own
   *      allow-list: reviewed exceptions must stay a small minority of individual-facing programs.
   *      It rescales itself if the allow-list ever legitimately grows.
   *   4. THE PREDICATE IS NOT BLIND, stated as a SHARE of that population rather than as a count.
   *      A corpus that doubles or halves passes unchanged; `licenceFloorOf` losing the axis, or
   *      `preference.ts` re-softening every floor, collapses it.
   *
   * A genuinely empty or collapsed load fails all four at once. Proven by deliberate break: with
   * `loadCorpus` returning no programs, claims 1–4 fail together and name the empty load.
   */
  it('reads a corpus that is actually populated, and finds licence floors in it', async () => {
    const { programs, loaded } = await corpus();

    // 1 — every source that loaded produced at least one record, on any of its three fates.
    const silent = loaded
      .filter((e) => e.programs + e.suppressed + e.belowAdjacency === 0)
      .map((e) => e.sourceId)
      .sort();
    expect(silent).toEqual([]);

    // 2 — and the audited population is EVERY registered source bar the signed exceptions. An
    // identity rather than a floor: adding or removing a source module moves both sides at once,
    // and a source dropping out moves only one.
    expect(loaded.length).toBe(SOURCES.length - NOT_IN_THE_AUDITED_POPULATION.size);

    // 3 — RULE B's population dwarfs the reviewed exceptions it is allowed to skip.
    const individual = programs.filter((p) => p.applicantEntities.includes('individual'));
    expect(individual.length).toBeGreaterThan(ALLOWED.size * 4);

    // 4 — and the floors are found. A share, not a count: the ARRL catalogue supplies most of
    // them, and every catalogue entry but North Fulton carries one.
    const withFloor = programs.filter((p) => licenceFloorOf(p) !== undefined);
    expect(withFloor.length).toBeGreaterThan(individual.length / 2);
    expect(new Set(withFloor.map((p) => licenceFloorOf(p)))).toEqual(new Set(['TECH', 'GENERAL']));
  });

  /**
   * Claim 2 as a NAMED failure rather than a count mismatch. `26 !== 24` tells a reader nothing;
   * this tells them which source left the audit and what `loadCorpus` said when it dropped it.
   */
  it('audits every registered source, and names any that has left the population', async () => {
    const { loaded, skipped } = await corpus();
    const audited = new Set(loaded.map((e) => e.sourceId));
    const why = new Map(skipped.map((e) => [e.sourceId, e.why]));
    const gone = SOURCES.map((s) => s.id)
      .filter((id) => !audited.has(id) && !NOT_IN_THE_AUDITED_POPULATION.has(id))
      .map(
        (id) =>
          `source "${id}" produced NO audited records — loadCorpus reports: ` +
          `${why.get(id) ?? 'it was neither loaded nor skipped, which should be impossible'}. ` +
          'Every programme it publishes is now outside RULE A and RULE B. Restore the source, or ' +
          'sign it in NOT_IN_THE_AUDITED_POPULATION with the exact `why` loadCorpus reports.',
      )
      .sort();
    expect(gone).toEqual([]);
  });

  it('keeps NOT_IN_THE_AUDITED_POPULATION honest in both directions', async () => {
    const { loaded, skipped } = await corpus();
    const audited = new Set(loaded.map((e) => e.sourceId));
    const why = new Map(skipped.map((e) => [e.sourceId, e.why]));
    const registered = new Set(SOURCES.map((s) => s.id));
    const stale: string[] = [];
    for (const [id, entry] of NOT_IN_THE_AUDITED_POPULATION) {
      if (!registered.has(id)) {
        stale.push(`"${id}" is not a registered source any more — delete the entry.`);
        continue;
      }
      if (audited.has(id)) {
        stale.push(
          `"${id}" IS being audited now, so the exemption is dead documentation — delete it and ` +
            'let RULE A and RULE B see the source.',
        );
        continue;
      }
      const actual = why.get(id);
      if (actual !== entry.why) {
        stale.push(
          `"${id}" is excluded for a DIFFERENT reason than the one signed. Signed: ` +
            `${JSON.stringify(entry.why)}. loadCorpus now says: ${JSON.stringify(actual)}. A ` +
            'signal-only source producing no candidates and a source whose parser started ' +
            'throwing look identical from here; only the reason distinguishes them.',
        );
      }
    }
    expect(stale).toEqual([]);
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
