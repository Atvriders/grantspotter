import type { RawOpportunity, SourceModule } from '@grantspotter/core';
import { type SinglePageConfig, makeSinglePageSource } from './util/singlePage.js';

interface YlrlAward {
  /** Stable externalKey — NOT derived from page text. */
  key: string;
  /** Stable display name — NOT derived from page text. */
  name: string;
  /** Matches however the page happens to write the person + callsign pair. */
  mention: RegExp;
}

/**
 * Canonical identities for the three memorial scholarships.
 *
 * The REAL ylrl.net page (captured 2026-08-03) has no per-scholarship headings at all: each
 * award is one sentence inside a shared paragraph — `The Ethel Smith, K4LMB, Memorial
 * Scholarship awards $2,500.` — with commas between name and callsign, and Marte Wessel written
 * `Martha “Marte” Wessel, K0EPE` with curly quotes. The previous heading regex required a line
 * that BEGAN with the bare name and ENDED in "Scholarship", so it matched nothing on the live
 * page and this source yielded zero records from its own page while the synthetic suite stayed
 * green. Matching a name+callsign MENTION anywhere in a line, rather than a whole-line heading,
 * is what makes both page shapes parse.
 *
 * Identity is fixed here rather than lifted from the page because the live page's naming
 * sentence also carries the dollar figure: using it verbatim as name/externalKey (as the old
 * parser did) would make a program's identity change the day its award amount changed, which
 * the diff layer reads as one program vanishing and a different one appearing.
 */
const YLRL_AWARDS: readonly YlrlAward[] = [
  {
    key: 'ylrl-ethel-smith-k4lmb',
    name: 'Ethel Smith K4LMB Memorial Scholarship',
    mention: /Ethel\s+Smith\s*,?\s*K4LMB/i,
  },
  {
    key: 'ylrl-mary-lou-brown-nm7n',
    name: 'Mary Lou Brown NM7N Memorial Scholarship',
    mention: /Mary\s+Lou\s+Brown\s*,?\s*NM7N/i,
  },
  {
    key: 'ylrl-marte-wessel-k0epe',
    name: 'Marte Wessel K0EPE Memorial Scholarship',
    mention: /Marte[\s”“"'’]*Wessel\s*,?\s*K0EPE/i,
  },
];

/**
 * Shared with the `ylrl` config's `fieldPatterns.eligibility` below — same restriction, one
 * pattern. The live page states the restriction as a bare bullet, `Applicant must be female.`,
 * NOT as the "licensed women…" prose the old single alternative assumed; that alternative is
 * kept because the restriction has been worded that way before and both are true statements of
 * the same rule.
 */
const YLRL_ELIGIBILITY_SENTENCE =
  /((?:Applicants? must be female|licensed[^.]*(?:women|female|YL))[^.]*\.)/i;

/**
 * The licence bullet, shared with the `ylrl` config's `fieldPatterns.license` below. Named
 * separately from the eligibility sentence because `extractLicense` reads ONLY the `license` /
 * `License Requirement` fields: text that lands anywhere else — `eligibility`, `rawText` — never
 * reaches the licence axis, so a licence requirement filed under `eligibility` is a licence
 * requirement that is not enforced.
 */
const YLRL_LICENSE_SENTENCE = /(Applicants? must have an Amateur Radio License[^.]*\.)/i;

/**
 * Every document-level restriction sentence, in page order. YLRL states its two hard rules —
 * female, and licensed — as two separate bullets on the live page, so a single-sentence capture
 * necessarily drops one of them.
 */
const YLRL_ELIGIBILITY_PATTERNS: readonly RegExp[] = [
  YLRL_ELIGIBILITY_SENTENCE,
  YLRL_LICENSE_SENTENCE,
];

export function ylrlEligibility(flatText: string): string {
  const found: string[] = [];
  for (const re of YLRL_ELIGIBILITY_PATTERNS) {
    const m = re.exec(flatText);
    if (m) found.push((m[1] ?? m[0]).replace(/\s+/g, ' ').trim());
  }
  return found.join(' ');
}

/** The document-level licence bullet on its own, for the `license` field of each named record. */
export function ylrlLicense(flatText: string): string | undefined {
  const m = YLRL_LICENSE_SENTENCE.exec(flatText);
  return m ? (m[1] ?? m[0]).replace(/\s+/g, ' ').trim() : undefined;
}

const YLRL_APPLY_URL = /(https?:\/\/ylrl\.net\/apply\/?)/i;

/**
 * One YLRL page carries three distinct named scholarships; each becomes its own record.
 *
 * Attribution is per LINE, not per heading block: a line belongs to every award whose
 * name+callsign it mentions. That is required by the live page, which ends with two bullets
 * that deliberately name more than one scholarship at a time ("The Ethel Smith, K4LMB and Mary
 * Lou Brown, NM7N scholarships are intended for full-time students…"). Lines that mention no
 * award at all are absorbed as a continuation of the preceding single-award line — that is what
 * carries "Award: $2,500." on a page shaped like the synthetic fixture — and the continuation
 * stops at the next award mention or the next section heading, so nothing bleeds sideways.
 */
export function parseYlrlScholarships(
  flatText: string,
  html: string,
  sourceUrl: string,
): RawOpportunity[] {
  const lines = flatText.split('\n');
  const mentions = lines.map((line) =>
    YLRL_AWARDS.filter((a) => a.mention.test(line)).map((a) => a.key),
  );
  const eligibility = ylrlEligibility(flatText);
  const license = ylrlLicense(flatText);
  const applyUrl = YLRL_APPLY_URL.exec(html)?.[1];
  const out: RawOpportunity[] = [];

  for (const award of YLRL_AWARDS) {
    const own = new Set<number>();
    mentions.forEach((keys, i) => {
      if (keys.includes(award.key)) own.add(i);
    });
    if (own.size === 0) continue;

    const solo = mentions.findIndex((keys) => keys.length === 1 && keys[0] === award.key);
    if (solo >= 0) {
      for (let i = solo + 1; i < lines.length; i += 1) {
        // Another award's territory, or a new section ("Scholarship Requirements:") — stop.
        if (mentions[i].length > 0) break;
        if (/:$/.test(lines[i].trim())) break;
        own.add(i);
      }
    }

    const body = [...own]
      .sort((a, b) => a - b)
      .map((i) => lines[i])
      .join('\n')
      .trim();
    const amount = /\$\s?[\d,]+/.exec(body)?.[0]?.replace(/\s+/g, '');
    const summary = body.replace(/\s+/g, ' ').trim();

    const rawFields: Record<string, string> = { scope: 'named_scholarship' };
    if (amount) rawFields.amount = amount;
    // Explicit per-record summary so the shared `eligibility` text below (needed for the gender
    // constraint axis) never displaces this record's own amount/body in normalize's summary
    // field-priority chain.
    if (summary) rawFields.summary = summary;
    // The women-only restriction is document-level on every shape this page has ever taken, and
    // applies to all three awards. Attaching it to each record is the only thing that stops
    // three genuinely female-only scholarships publishing as open to everyone.
    if (eligibility) rawFields.eligibility = eligibility;
    // Same argument, licence axis — and the same defect the QCWA config above carried. The
    // licence bullet is document-level too, but it only ever reached the whole-page record's
    // `license` field via fieldPatterns; these three named records carried it inside
    // `eligibility`, where `extractLicense` cannot see it, so all three published with no
    // licence floor at all. Only the unrelated female-only gender constraint was keeping them
    // away from unlicensed applicants, and a hard rule must not rest on another axis's accident.
    if (license) rawFields.license = license;
    if (applyUrl) rawFields.detailUrl = applyUrl;

    out.push({
      sourceId: 'ylrl',
      externalKey: award.key,
      name: award.name,
      rawFields,
      sourceUrl,
      rawText: [eligibility, body].filter(Boolean).join('\n').trim(),
    });
  }
  return out;
}

const CONFIGS: SinglePageConfig[] = [
  {
    id: 'qcwa',
    funderId: 'qcwa',
    label: 'QCWA Memorial Scholarship Fund',
    tier: 'C',
    klass: 'ham_scholarship',
    url: 'https://www.qcwa.org/scholarship-program.htm',
    name: 'QCWA Memorial Scholarship',
    externalKey: 'qcwa-memorial-scholarship',
    fieldPatterns: {
      // The live page publishes NO per-award figure (see notes). This pattern therefore demands
      // an explicitly per-award phrasing rather than "any dollar sign on the page": the only
      // figures qcwa.org actually prints are a historical first award ($500 in 1978) and two
      // lifetime/annual totals ($57,000 across 15 awards in 2024, $930,350 since inception).
      // A bare /\$[\d,]+/ here would publish one of those as the award size.
      amount: /(?:each scholarship is|scholarships? of|awards? of)\s*(\$[\d,]+)/i,
      sponsor: /((?:sponsored|recommended) by an active QCWA member[^.]*\.)/i,
      requestWindow: /(on or after October 31[^.]*\.)/i,
      deadlineNote: /(before the first week (?:in|of) January[^.]*\.)/i,
      applyNote: /((?:administered in partnership with|submitted through) the ARRL Foundation[^.]*\.)/i,
      applyUrl: /(https?:\/\/www\.arrl\.org\/scholarship[a-z-]*)/i,
      // THE LICENCE REQUIREMENT ITSELF, which this config used to drop on the floor.
      //
      // `eligibility` below keeps "There are no restrictions regarding class of amateur license,
      // race, sex, residence, or field of study." — a sentence that PRESUPPOSES a licence but
      // never states that one is needed. `extractLicense` reads `License Requirement`/`license`
      // and nothing else, so with no `license` field it emitted no constraint at all, and QCWA
      // published as eligible to an applicant holding no amateur licence. The live page is
      // explicit twice over: applications are "requested by interested licensed radio amateurs",
      // and "Scholarships are awarded to worthy Amateur Radio operators enrolled in accredited
      // colleges or universities". Honouring an unambiguous funder statement is not
      // over-restriction; the false-include leniency this codebase applies elsewhere is for
      // AMBIGUOUS text.
      //
      // Leading `[^.\n]*` so the sentence is captured from its own start rather than mid-clause
      // (same idiom as SARA's `audience` below). The alternation covers both of the page's own
      // wordings plus the "licensed amateur radio operators" variant, so a rewrite has to remove
      // every statement of the requirement — not merely reword one — before this goes quiet.
      license:
        /([^.\n]*\b(?:licensed radio amateurs?|licensed amateur radio operators?|Amateur Radio operators?)\b[^.]*\.)/i,
      eligibility: /(no restrictions regarding[^.]*\.)/i,
      history: /(As of \d{4}, [\d,]+ scholarships totaling \$[\d,]+[^.]*\.)/i,
      // Without this the summary falls back to the whole flattened page, which on the live page
      // is mostly a donation appeal plus the treasurer's home postal address.
      summary: /(The QCWA Scholarship Program is administered[^.]*\.|Scholarships are awarded[^.]*\.)/i,
    },
    // NOT `amount`: requiring it is what made this source return zero records from its own live
    // page while the synthetic-fixture suite stayed green. These four are the facts qcwa.org
    // does print, and losing any of them is a real change worth an empty-yield alarm.
    //
    // `license` is required for a sharper reason than the other three. If the other three go
    // quiet the record merely gets thinner; if the licence sentence goes quiet the record gets
    // WIDER — it silently reverts to publishing a licensed-operators-only scholarship as open to
    // everyone, which is the defect this entry exists to prevent. An empty yield is loud and a
    // human fixes it the same day; a missing licence floor is silent and misleads applicants
    // until someone re-reads the page.
    requiredFields: ['sponsor', 'deadlineNote', 'applyNote', 'license'],
    expectedMinRecords: 1,
    notes:
      'NO PER-AWARD AMOUNT IS PUBLISHED. The live page (captured 2026-08-03) prints only a ' +
      'historical $500 first award (1978) and totals — 15 awards / $57,000 in 2024, 624+ ' +
      'students / $930,350+ since 1978 — which do not even divide to the $3,000 previously ' +
      'hardcoded here (15 x $3,000 = $45,000, not $57,000). Amount stays unknown rather than ' +
      'guessed. Intake is the ARRL Foundation portal at arrl.org/scholarship-descriptions, NOT ' +
      'QCWA — the deadline is INHERITED from arrl-scholarship-program. A recommendation from an ' +
      'active QCWA member is a hard requirement. AN AMATEUR RADIO LICENCE IS A HARD REQUIREMENT: ' +
      'applications are "requested by interested licensed radio amateurs" and "Scholarships are ' +
      'awarded to worthy Amateur Radio operators". The page adds that there are "no restrictions ' +
      'regarding class of amateur license" — that is ANY CLASS QUALIFIES (floor TECH), not "no ' +
      'licence needed", and the two must never be conflated. The live page carries NO ' +
      'farweb.org link (the ' +
      'earlier note here claimed it did); that domain remains hard-blocklisted in the fetcher ' +
      'because it now redirects to a gambling site.',
  },
  {
    id: 'ylrl',
    funderId: 'ylrl',
    label: 'Young Ladies Radio League scholarships',
    tier: 'C',
    klass: 'ham_scholarship',
    url: 'https://ylrl.net/Scholarships/',
    name: 'YLRL Scholarships',
    externalKey: 'ylrl-scholarships',
    fieldPatterns: {
      eligibility: YLRL_ELIGIBILITY_SENTENCE,
      license: YLRL_LICENSE_SENTENCE,
      residency: /(There are no residency restrictions[^.]*\.(?:\s*Non-U\.?S\.? Amateurs are eligible\.)?)/i,
      membershipPreference: /(Preference will be given to YLRL members[^.]*\.)/i,
      studyPreference: /(Preference will be given to students studying[^.]*\.)/i,
      detailUrl: YLRL_APPLY_URL,
    },
    requiredFields: ['eligibility'],
    expectedMinRecords: 3,
    extraParse: parseYlrlScholarships,
    notes:
      'Female licensed hams only — the ONLY gender-scoped record in the corpus, and the reason ' +
      'ConstraintAxis has a gender axis. Verified against the live page 2026-08-03: "Applicant ' +
      'must be female." and "Applicant must have an Amateur Radio License." are two separate ' +
      'bullets that apply to all three awards. Three named scholarships on one page: Ethel ' +
      'Smith K4LMB ($2,500), Mary Lou Brown NM7N ($2,500), Marte Wessel K0EPE ($1,500, aimed at ' +
      'part-time students working full-time — stay-at-home parents and caregivers count as ' +
      'full-time work; high-school students are exempt from it). Non-US applicants eligible ' +
      '("There are no residency restrictions. Non-U.S. Amateurs are eligible."); YLRL ' +
      'membership is a preference, not a bar. One of only two verified non-ARRL US ham ' +
      'scholarship application paths. The live page publishes NO opening or deadline date — it ' +
      'links to ylrl.net/apply/ for those, captured here as detailUrl.',
  },
  {
    id: 'austin-arc',
    funderId: 'austin-arc',
    label: 'Austin Amateur Radio Club scholarships',
    tier: 'C',
    klass: 'ham_scholarship',
    url: 'https://austinhams.org/scholarships/',
    // The live page (captured 2026-08-03) names NO individual scholarship: it is headed "Club
    // Scholarships" and says only "Students are encouraged to apply to all scholarships for
    // which they are eligible." The strings "Copeland" and "Greenwood" appear nowhere on it, so
    // the old name asserted two named awards this source cannot verify.
    name: 'Austin ARC Club Scholarships',
    externalKey: 'austin-arc-scholarships',
    fieldPatterns: {
      // Whole sentence, not a bare date pair: the live page's first statement of the window is
      // "Applications open May 1 and close July 31 each year", which the old
      // `May 1 … Jul 31` fragment pattern rendered as the unreadable "May 1 and close July 31".
      window: /(Applications?[^.]*May\s*1[^.]*Jul(?:y)?\s*31[^.]*\.)/i,
      counties: /((?:Travis|Williamson|Hays|Bastrop|Caldwell|Burnet|Blanco)[^.]*\.)/i,
      audience: /(Students pursuing[^.]*\.|Applicants must reside[^.]*\.)/i,
      // Unquoted href attribute on the live page (`href=https://grants.austinhams.org`), so the
      // pattern must not assume quoting.
      detailUrl: /(https?:\/\/grants\.austinhams\.org[^\s"'<>]*)/i,
    },
    requiredFields: ['window'],
    expectedMinRecords: 0,
    notes:
      'expectedMinRecords is deliberately 0. The APPLY PORTAL, grants.austinhams.org, ' +
      'legitimately shows "No opportunities available" between August 1 and April 30 — an empty ' +
      'scrape is the correct answer for eight months of the year, not a failure, and diff/ must ' +
      'not emit vanished events for it. Note that the page this source actually fetches, ' +
      'austinhams.org/scholarships/, is static and keeps describing the window year-round: the ' +
      '2026-08-03 capture, taken three days AFTER the window closed, still yields one record. ' +
      'Window is May 1 - Jul 31 ("Applications open May 1 and close July 31 each year"); search ' +
      'engines still show a stale "March 25, 2026" that contradicts the live page. Central ' +
      'Texas, seven named counties, listed on the live page with an Oxford comma ("Travis, ' +
      'Bastrop, Blanco, Burnet, Caldwell, Hays, and Williamson counties"). NO AMOUNT IS ' +
      'PUBLISHED — there is not a single dollar figure on the page. The self-hosted portal ' +
      'exposes no public JSON — /api* probes return 404. Best verified example of a regional ' +
      'non-ARRL program.',
  },
  {
    id: 'sara',
    funderId: 'sara',
    label: 'SARA Student and Teacher Project Grants',
    tier: 'C',
    klass: 'equipment_in_kind',
    url: 'https://www.radio-astronomy.org/grants',
    name: 'SARA Student and Teacher Project Grants',
    externalKey: 'sara-student-teacher-grants',
    fieldPatterns: {
      // Keep the cap phrase, not just the figure: the live page's sentence is "small grants of
      // no more than $200 each or more, with the approval of the grant committee", and starting
      // the capture at the bare "$200" threw away the "no more than" that makes it a ceiling.
      amount: /((?:no more than |typically )?\$200[^.]*\.)/i,
      // Leading `[^.\n]*` so the sentence is captured from its own start. The live page puts
      // this whole program in ONE giant <p>, so the qualifier that matters — that 5th-grade
      // through college is a PREFERENCE, not a bar — sits in front of the phrase the old
      // pattern anchored on and was silently dropped.
      audience: /([^.\n]*(?:5th|fifth) grade[^.]*college[^.]*\.)/i,
      teachers: /(UPDATE: Teachers are now eligible[^.]*\.|Open to[^.]*teachers[^.]*\.)/i,
      // The live page spells the address "grants at radio-astronomy.org" as an anti-spam
      // measure. The old @-only pattern therefore matched nothing on the real page and dropped
      // the ONLY intake path this funder publishes.
      applyNote: /([\w.+-]+\s*(?:@|\bat\b)\s*radio-astronomy\.org)/i,
      summary: /(The Society of Amateur Radio Astronomers provides funds[^.]*\.|Grants are typically[^.]*\.)/i,
    },
    requiredFields: ['audience', 'applyNote'],
    expectedMinRecords: 1,
    notes:
      'Society of Amateur Radio Astronomers. Live page 2026-08-03: "several small grants of no ' +
      'more than $200 each or more, with the approval of the grant committee"; 5th grade ' +
      'through college is stated as a PREFERENCE ("Preference will be given to students 5th ' +
      'grade through college and to new and innovative ideas"), not a hard bar; teachers became ' +
      'eligible by a later UPDATE line. International. ROLLING — no deadline appears anywhere ' +
      'on the page, so DeadlineKind is rolling, never a guessed date. Apply by emailing a ' +
      'Word/PDF form to grants at radio-astronomy.org (spelled out, not an @, on the page). ' +
      'CAVEAT: the instrument is pinned to in_kind_equipment in normalize on the strength of ' +
      'earlier research into kit awards (Radio JOVE, SuperSID), but THIS page describes cash — ' +
      '"provides funds", "the money reaches the largest number of students" — and mentions ' +
      'Radio JOVE / SuperSID / INSPIRE only as external project ideas, never as the award ' +
      'itself. Treat in_kind_equipment as unverified against the live page.',
  },
];

const [qcwaModule, ylrlModule, austinModule, saraModule] = CONFIGS.map(makeSinglePageSource);

export const qcwa = qcwaModule;
export const ylrl = ylrlModule;
export const austinArc = austinModule;
export const sara = saraModule;
export const TIER_C_A_SOURCES: SourceModule[] = [qcwa, ylrl, austinArc, sara];
