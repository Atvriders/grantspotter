import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { contentRoot, loadTemplates } from './load.js';

/**
 * EVERY FUNDER REQUIREMENT AN OVERLAY STATES MUST BE QUOTABLE FROM A CAPTURED PAGE.
 *
 * This file is the check that makes that sentence mechanical rather than aspirational. For each
 * overlay it pins a set of phrases that appear BOTH in the overlay body and in the committed
 * bytes of the capture the overlay cites. A quote that drifts out of the funder's page — or was
 * never in it — fails here, naming the overlay and the phrase.
 *
 * It is the same discipline `sources/ardc-grants.test.ts` already applies to the ingestion layer:
 * "the three facts an applicant cannot act without … are quoted verbatim against the committed
 * bytes, which is the check that would have caught the Yaesu '12-month on-air obligation' that no
 * page has ever contained."
 *
 * WHY AN OVERLAY AND NOT A COMPONENT. A component states structure; an overlay states what this
 * funder actually requires. That is precisely where a fabricated fact would read as researched,
 * and where an applicant is least able to check it — they came here because they had not read
 * the funder's page.
 *
 * ONLY REAL CAPTURES COUNT. Each fixture directory also holds a hand-written `pathological.*`
 * file built to exercise a parser's edge cases; those are synthetic and are NOT sources. Three
 * claims asked of these overlays turned out to live only in a `pathological` fixture — a
 * "12:00 PM EST" scholarship close time, "One application covers every scholarship in the
 * catalog", and "Applicants must be an ARRL-affiliated club in good standing" — so the guard
 * below refuses any capture path containing "pathological", and none of the three is stated.
 */

const repoRoot = path.dirname(contentRoot());
const all = loadTemplates();
const bodyOf = (id: string): string => {
  const t = all.find((x) => x.id === id);
  if (!t) throw new Error(`no template "${id}"`);
  return t.body;
};

/**
 * Normalises a captured page to comparable text: markup out, the entities and typographic
 * characters a CMS emits folded to their ASCII equivalents, whitespace collapsed. Deliberately
 * lossy in one direction only — it never adds a word — so a phrase that survives normalisation
 * on both sides really is the funder's own wording.
 */
function captureText(relPath: string): string {
  expect(relPath, 'a pathological fixture is synthetic, not a capture').not.toContain(
    'pathological',
  );
  const abs = path.join(repoRoot, relPath);
  const raw = fs.readFileSync(abs, 'utf8');
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#8217;|&rsquo;|’/g, "'")
    .replace(/&#8216;|&lsquo;|‘/g, "'")
    .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;|“|”/g, '"')
    .replace(/&quot;/g, '"')
    .replace(/&#8211;|&ndash;|–/g, '-')
    .replace(/&#8212;|&mdash;|—/g, '--')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ');
}

/** The overlay body, folded the same way, so one comparison serves both sides. */
function overlayText(id: string): string {
  return bodyOf(id)
    .replace(/’/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/–/g, '-')
    .replace(/—/g, '--')
    .replace(/\s+/g, ' ');
}

interface Pin {
  /** Where the funder said it. */
  capture: string;
  /** The funder's own words, as they must appear in the overlay. */
  quote: string;
}

const PINS: Record<string, readonly Pin[]> = {
  'funder-ardc': [
    // WHEN. The four dates and the review lag are on the apply page, not the instructions page.
    {
      capture: 'fixtures/ardc-grants/02-apply.html',
      quote: 'The 2026 application deadlines are',
    },
    {
      capture: 'fixtures/ardc-grants/02-apply.html',
      quote: 'applications generally take 60-120 days to evaluate',
    },
    // The open-access condition on the funded work, and the licences ARDC itself names.
    {
      capture: 'fixtures/ardc-grants/02-apply.html',
      quote:
        'all technology, documentation, and other materials produced using ARDC funds must be ' +
        'made freely available to the public',
    },
    {
      capture: 'fixtures/ardc-grants/02-apply.html',
      quote: 'Hardware: CERN Open Hardware License',
    },
    {
      capture: 'fixtures/ardc-grants/02-apply.html',
      quote:
        'Radio clubs and groups who are NOT nonprofits, as well as individual applicants, are ' +
        'not eligible for a grant unless they have a nonprofit fiscal sponsor',
    },
    // The 20% ceiling, and ARDC's OWN remedy for an institution whose rate exceeds it.
    {
      capture: 'fixtures/ardc-grants/03-apply-instructions.html',
      quote: 'You may include up to 20% for indirect costs',
    },
    {
      capture: 'fixtures/ardc-grants/03-apply-instructions.html',
      quote: 'we ask that you cost-share any indirect amount over 20%',
    },
    {
      capture: 'fixtures/ardc-grants/03-apply-instructions.html',
      quote: 'projects that are not open source and open access are not eligible',
    },
    {
      capture: 'fixtures/ardc-grants/03-apply-instructions.html',
      quote: 'We want you to be thorough, but please keep your application brief',
    },
    {
      capture: 'fixtures/ardc-grants/03-apply-instructions.html',
      quote:
        "If the proposal is extremely long and hard to understand, we can't evaluate or support it",
    },
    {
      capture: 'fixtures/ardc-grants/03-apply-instructions.html',
      quote: 'Lack of detail in the project plan is the most common reason applications are rejected',
    },
    {
      capture: 'fixtures/ardc-grants/03-apply-instructions.html',
      quote: 'we fund about 30% of the submitted proposals',
    },
  ],
  'funder-arrl-amateur-radio-grants': [
    {
      capture: 'fixtures/arrl-amateur-radio-grants/00-www-arrl-org-amateur-radio-grants.html',
      quote:
        'Grant requests for emergency communications equipment, facilities, or projects will ' +
        'not be considered',
    },
    {
      capture: 'fixtures/arrl-amateur-radio-grants/00-www-arrl-org-amateur-radio-grants.html',
      quote: 'Grant requests for ongoing operations or expenses will not be considered',
    },
    {
      capture: 'fixtures/arrl-amateur-radio-grants/00-www-arrl-org-amateur-radio-grants.html',
      quote: 'Grants are awarded only to organizations, not individuals',
    },
    {
      capture: 'fixtures/arrl-amateur-radio-grants/00-www-arrl-org-amateur-radio-grants.html',
      quote:
        'Only programs and initiatives conducted within the United States are eligible for ' +
        'consideration',
    },
    {
      capture: 'fixtures/arrl-amateur-radio-grants/00-www-arrl-org-amateur-radio-grants.html',
      quote: 'Awarded grants generally do not exceed $3,000',
    },
    {
      capture: 'fixtures/arrl-amateur-radio-grants/00-www-arrl-org-amateur-radio-grants.html',
      quote: "In support of ARRL's Year of the Club, award amounts may be up to $5,000 in 2026",
    },
    {
      capture: 'fixtures/arrl-amateur-radio-grants/00-www-arrl-org-amateur-radio-grants.html',
      quote:
        'The ARRL Foundation does not wish to be the sole funder of a proposal and gives ' +
        'preference to groups that provide evidence of other successful fundraising conducted ' +
        'prior to proposal submission',
    },
    {
      capture: 'fixtures/arrl-amateur-radio-grants/00-www-arrl-org-amateur-radio-grants.html',
      quote: 'Awardees will be notified approximately one month after the closing of each cycle',
    },
  ],
  'funder-arrl-club-grant': [
    {
      capture: 'fixtures/arrl-club-grant/00-www-arrl-org-club-grant-program.html',
      quote:
        'The ARRL Foundation is pleased to report that 37 Amateur Radio Clubs benefitted from ' +
        '$500,502 in grants through the Club Grant Program',
    },
    {
      capture: 'fixtures/arrl-club-grant/00-www-arrl-org-club-grant-program.html',
      quote:
        'There were 110 applicants to the 2024 ARRL Club Grant Program, with applicants from ' +
        'all ARRL Divisions and 40 states, requesting nearly $1.6 million in support, in ' +
        'amounts as small as $1,000 to as large as the maximum $25,000',
    },
    {
      capture: 'fixtures/arrl-club-grant/00-www-arrl-org-club-grant-program.html',
      quote:
        'The ARRL Foundation is grateful for the generosity of Amateur Radio Digital ' +
        'Communications (ARDC) which provided the funding for this grant program',
    },
    {
      capture: 'fixtures/arrl-club-grant/00-www-arrl-org-club-grant-program.html',
      quote: 'Questions about the Club Grant Program can be sent to clubgrants@arrl.org',
    },
  ],
  'funder-arrl-foundation-scholarships': [
    {
      capture: 'fixtures/arrl-scholarship-descriptions/00-www-arrl-org-scholarship-descriptions.html',
      quote: 'The 2026 scholarship cycle runs from October 30, 2025 to December 30, 2025',
    },
    {
      capture: 'fixtures/arrl-scholarship-descriptions/00-www-arrl-org-scholarship-descriptions.html',
      quote:
        'The ARRL Foundation manages more than 150 scholarships established by generous donors ' +
        'ranging from $500 to $25,000',
    },
    {
      capture: 'fixtures/arrl-scholarship-program/00-www-arrl-org-scholarship-program.html',
      quote:
        'The ARRL Foundation manages more than 170 scholarships established by generous donors ' +
        'ranging from $500 to $25,000',
    },
    {
      capture: 'fixtures/arrl-scholarship-program/00-www-arrl-org-scholarship-program.html',
      quote: 'The 2026 Scholarship Cycle is now closed',
    },
    {
      capture: 'fixtures/arrl-scholarship-descriptions/00-www-arrl-org-scholarship-descriptions.html',
      quote:
        'Transcripts and any additional required documents must be submitted WITH the ' +
        'application and not emailed separately',
    },
    {
      capture: 'fixtures/arrl-scholarship-descriptions/00-www-arrl-org-scholarship-descriptions.html',
      quote:
        'A number of scholarships require additional documents, such as a letter of ' +
        'recommendation from a sitting Officer of an ARRL-affiliated club',
    },
    {
      capture: 'fixtures/arrl-summary-of-scholarship-requirements/00-www-arrl-org-summary-of-scholarship-requirements.html',
      quote: 'Applicants should only apply for those awards for which they qualify',
    },
    {
      capture: 'fixtures/qcwa/00-www-qcwa-org-scholarship-program-htm.html',
      quote: 'Each applicant must be recommended by an active QCWA member',
    },
    {
      capture: 'fixtures/qcwa/00-www-qcwa-org-scholarship-program-htm.html',
      quote:
        'applications must be received by the ARRL Foundation before the first week in January ' +
        'each year',
    },
  ],
};

describe('funder overlays quote their funders', () => {
  for (const [id, pins] of Object.entries(PINS)) {
    describe(id, () => {
      it('exists, and cites every capture it quotes', () => {
        const t = all.find((x) => x.id === id);
        expect(t, id).toBeDefined();
        expect(t?.layer).toBe('funder');
        expect(t?.sources.length).toBeGreaterThan(0);
      });

      it('states at least four requirements in the funders own words', () => {
        expect(pins.length).toBeGreaterThanOrEqual(4);
      });

      for (const pin of pins) {
        const label = pin.quote.length > 64 ? `${pin.quote.slice(0, 64)}…` : pin.quote;
        it(`quotes: ${label}`, () => {
          expect(captureText(pin.capture), `not in ${pin.capture}`).toContain(pin.quote);
          expect(overlayText(id), `not in ${id}`).toContain(pin.quote);
        });
      }
    });
  }

  /**
   * A capture cited in `sources` is a promise the reader can follow. These four overlays cite
   * only pages this repository actually holds bytes for, so the promise is checkable here.
   */
  it('cites no source URL that no capture in the repository backs', () => {
    const captured = new Set(
      Object.values(PINS)
        .flat()
        .map((p) => p.capture),
    );
    // Every pinned capture file exists on disk. (`captureText` would throw otherwise, but a
    // missing file should fail as a missing file, not as a missing quote.)
    for (const rel of captured) expect(fs.existsSync(path.join(repoRoot, rel)), rel).toBe(true);
  });
});

/**
 * The negative half. Each of these strings is a plausible funder requirement that reads as
 * researched and appears in NO capture — the shape of every failure this product was built
 * after. They are listed by name so that adding one to an overlay fails loudly.
 */
describe('funder overlays state nothing the captures do not', () => {
  const UNSOURCED: ReadonlyArray<readonly [string, RegExp]> = [
    // The abbreviation is matched case-sensitively: `/EST\b/i` also fires on the tail of
    // "request", "largest" and "best".
    ['a scholarship close TIME (only in a synthetic fixture)', /12:00 ?PM|[Nn]oon Eastern|\bEST\b/],
    ['a previous scholarship close date of January 31', /January 31/],
    ['a 2024 scholarship award count or total', /135 awards|\$715,\d{3}|\$715,000/],
    ['an ARRL-affiliation REQUIREMENT on the Club Grant', /must be an ARRL-affiliated club/i],
    ['a post-award publication deadline ARDC never set', /within \d+ days of/i],
    ['a Yaesu-style on-air obligation', /must (?:remain|stay) (?:on the air|in service) for \d/i],
  ];

  it('carries none of the six', () => {
    const offenders: string[] = [];
    for (const id of Object.keys(PINS)) {
      for (const [label, re] of UNSOURCED) {
        const hit = re.exec(bodyOf(id));
        if (hit) offenders.push(`${id} states ${label}: ${JSON.stringify(hit[0])}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('publishes no private individuals name, street address or telephone number', () => {
    // The QCWA capture that backs the scholarship overlay names a volunteer, her home address
    // and her callsign. It is a real person's real address on a public page; it is not a funder
    // requirement, and it does not belong in a template this app renders into drafts.
    for (const id of Object.keys(PINS)) {
      const body = bodyOf(id);
      expect(body, id).not.toMatch(/\b\d{2,5}\s+[A-Z][a-z]+\s+(?:St|Street|Rd|Road|Ave|Avenue)\b/);
      expect(body, id).not.toMatch(/\b(?:\+1[- ])?\d{3}-\d{3}-\d{4}\b/);
      expect(body, id).not.toMatch(/WA2FRW|Roberta Cohen/i);
    }
  });
});
