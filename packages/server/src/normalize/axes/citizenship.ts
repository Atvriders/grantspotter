import type { Citizenship, Constraint, RawOpportunity } from '@grantspotter/core';
import { candidateTexts, findClause, splitClauses } from './clauses.js';
// The shared "a link label is not a sentence" filter. Imported from the axis whose defect forced
// it to be written, never re-derived: a second copy of a rule about what counts as eligibility
// text is how the two drift. `recommendation.ts` and `ageStage.ts` already import it for the same
// reason, and this axis carried the sixth constraint it was written to remove.
import { withoutSiteChrome } from './hamActivity.js';
import { makeConstraint } from './preference.js';

const WORD_MONTHS: Record<string, number> = { one: 1, two: 2, three: 3, six: 6, twelve: 12 };
const WITHIN = /within\s+(one|two|three|six|twelve|\d+)\s+months?\s+of\s+citizenship/i;
const CITIZEN = /\bcitizen(?:s|ship)?\b/i;

/** Wording that opens the award to applicants of any nationality outright. */
const OPEN_WORLDWIDE =
  /\b(?:worldwide|any country|international applicants?|regardless of (?:location or )?nationality)\b/i;
/**
 * The other half of "no citizenship requirement", stated as a negation rather than as a positive
 * scope. Both halves must be found IN THE SAME CLAUSE, because "US citizenship" and "not
 * required" can legitimately belong to two different requirements in one record.
 *
 * The 10-10 International and ARDC Scholarships both say, verbatim: "US licensure, US residence
 * and US citizenship are not requirements." The previous pattern spelled only the singular "is
 * not required", so both of the corpus's genuinely worldwide programmes — including its largest,
 * ARDC's 45 awards — fell through to the US-citizens-only branch below and were hidden from every
 * non-US applicant. That is the silence-read-as-prohibition shape, except that the funder was not
 * silent at all: it said the opposite, in words the regex could not spell.
 */
const US_STATUS =
  /\b(?:U\.?S\.?|United States)\s+(?:residence|residency|licensure|citizenship|license)\b/i;
const NOT_REQUIRED = /\b(?:is|are|was|were)?\s*not\s+(?:a\s+)?(?:required|requirements?)\b/i;
/**
 * An explicit positive requirement outranks worldwide-sounding language elsewhere in the record
 * ("open to women worldwide" says nothing about citizenship). Spelled to cover every real
 * variant: "must be a US citizen", "must be a U.S. citizen", "must be a United States citizen".
 */
const MUST_BE_US_CITIZEN = /\bmust be an?\s+(?:U\.?S\.?|United States)\s+citizens?\b/i;

/**
 * Residency wording that WIDENS who may apply. Searched across the whole record and not only the
 * extracted clause: adding US_RESIDENT can only ever admit more applicants, and a funder who
 * writes "Applicant must be a U.S. citizen. Permanent residents are also eligible." states the
 * widening in a separate sentence. All three spellings are specific enough not to collide with
 * geography wording — "residents of Texas" does not match.
 */
const US_RESIDENT_WORDING = /\b(?:permanent residents?|lawful residents?|U\.?S\.? residents?)\b/i;

function isWorldwideClause(clause: string): boolean {
  return OPEN_WORLDWIDE.test(clause) || (US_STATUS.test(clause) && NOT_REQUIRED.test(clause));
}

/**
 * SITE CHROME IS NOT ELIGIBILITY TEXT — ON THIS AXIS TOO.
 *
 * `candidateTexts` falls back to `raw.rawText`, and for a source filing no `Other` / `Region` /
 * `eligibility` field that is the WHOLE FLATTENED PAGE. `CITIZEN` is a single word, and on
 * nasa.gov it is a TOPIC LINK: the ONLY occurrence of "citizen" anywhere in the CubeSat Launch
 * Initiative capture is the nav item
 *
 *     Citizen Science
 *
 * sitting between "STEM Multimedia" and "View All Topics A-Z" in NASA's global menu. That one link
 * published `citizenship` HARD `{allowed: ["US_CITIZEN"]}` on the CSLI programme, quoting 1,500
 * characters of NASA's masthead back to the applicant as the funder's own eligibility words. NASA
 * does state a US-institution requirement for CSLI, but it says nothing about the CITIZENSHIP of
 * anyone, and a fabricated `US_CITIZEN` bar hides the programme from every non-US applicant with
 * no signal at all.
 *
 * Applied to every candidate, not only the `rawText` fallback, for the same reason `ageStage.ts`
 * and `recommendation.ts` do: a labelled field is not immune to a page whose flattener folded a
 * menu into it, and on a labelled field the filter is a no-op (a run of FOUR consecutive lines
 * carrying neither "." nor ":" is what it takes to drop anything, and only a menu produces that).
 */
export function extractCitizenship(raw: RawOpportunity): Constraint[] {
  const candidates = candidateTexts(
    [raw.rawFields.Other, raw.rawFields.Region, raw.rawFields.eligibility],
    raw.rawText,
  )
    .map(withoutSiteChrome)
    .filter((t) => t.trim() !== '');
  const text = candidates.join('\n');
  const worldwideClause = candidates.flatMap(splitClauses).find(isWorldwideClause);
  if (!CITIZEN.test(text) && worldwideClause === undefined) return [];

  if (worldwideClause !== undefined && !MUST_BE_US_CITIZEN.test(text)) {
    return [makeConstraint('citizenship', worldwideClause, { axis: 'citizenship', allowed: ['ANY'] }, 0)];
  }

  const clause = candidates.map((t) => findClause(t, CITIZEN)).find((c) => c !== undefined) ?? text;
  const allowed: Citizenship[] = ['US_CITIZEN'];
  if (US_RESIDENT_WORDING.test(text)) allowed.push('US_RESIDENT');
  const within = WITHIN.exec(clause);
  const withinMonthsOfCitizenship = within
    ? (WORD_MONTHS[within[1].toLowerCase()] ?? Number.parseInt(within[1], 10))
    : undefined;
  return [
    makeConstraint(
      'citizenship',
      clause,
      {
        axis: 'citizenship',
        allowed,
        ...(withinMonthsOfCitizenship !== undefined ? { withinMonthsOfCitizenship } : {}),
      },
      0,
    ),
  ];
}
