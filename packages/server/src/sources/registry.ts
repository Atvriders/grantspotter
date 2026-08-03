import type { Funder, SourceModule } from '@grantspotter/core';
import { ardcAwardTables } from './ardc-award-tables.js';
import { ardcGrants } from './ardc-grants.js';
import { ARRL_PAGE_SOURCES } from './arrl-pages.js';
import { arrlNewsRss } from './arrl-news-rss.js';
import { grantsGovExtract } from './grants-gov-extract.js';
import { grantsGovFederal } from './grants-gov-federal.js';
import { nsfAwards } from './nsf-awards.js';
import { usaSpending } from './usaspending.js';
import { arrlScholarshipDescriptions } from './arrl-scholarship-descriptions.js';
import { manualTierD } from './manual-tier-d.js';
import { nsfFundingRss } from './nsf-funding-rss.js';
import { TIER_C_A_SOURCES } from './tier-c-a.js';
import { TIER_C_B_SOURCES } from './tier-c-b.js';
import { yaesuDr2x } from './yaesu-dr2x.js';

/**
 * The complete source registry. 27 modules (Tasks 7-15, 24, 27 and 28 push into it).
 *
 * DO NOT add any Grants.gov RSS feed here. All four advertised feeds
 * (https://grants.gov/rss/GGRSSSynopsisNew.xml and siblings) return HTTP 200 with
 * content-type text/html — a ~27 KB single-page-app shell, not XML. A naive poller finds
 * zero items forever and never errors. Use POST https://api.grants.gov/v1/api/search2,
 * which is key-free and returns real JSON (see sources/grants-gov-federal.ts).
 *
 * DO NOT add farweb.org, candid.org, fconline.foundationcenter.org, grantwatch.com,
 * grantstation.com or instrumentl.com. They are refused inside the fetcher.
 */
const MODULES: SourceModule[] = [
  ardcGrants,
  ardcAwardTables,
  ...ARRL_PAGE_SOURCES,
  arrlNewsRss,
  arrlScholarshipDescriptions,
  manualTierD,
  nsfFundingRss,
  ...TIER_C_A_SOURCES,
  ...TIER_C_B_SOURCES,
  yaesuDr2x,
  grantsGovFederal,
  grantsGovExtract,
  nsfAwards,
  usaSpending,
];

export const SOURCES: readonly SourceModule[] = MODULES;

export function listSourceIds(): string[] {
  return MODULES.map((m) => m.id);
}

export function getSource(id: string): SourceModule {
  const found = MODULES.find((m) => m.id === id);
  if (!found) {
    throw new Error(`unknown source id "${id}"; known ids: ${listSourceIds().join(', ') || '(none)'}`);
  }
  return found;
}

/**
 * SEAM FIX (whole-branch review, 2026-08-02). `programs.funder_id` REFERENCES funders(id)
 * (001-init.sql:17), but nothing anywhere ever INSERTed a `funders` row — `sources.funder_id`
 * carries no FK (001-init.sql:81), so the nightly crawl wrote 27 modules' worth of records
 * against 16 distinct funderIds without SQLite ever objecting, and the first `approveReviewItem`
 * on a real install died on a raw `SqliteError: FOREIGN KEY constraint failed`. Both
 * `review/index.test.ts` and `db/repositories/ingestion.test.ts` hand-insert the one funder they
 * each exercise, which is exactly what hid this: the tests built the precondition the product
 * itself never built.
 *
 * The registry is the natural place to fix it — it already imports every module and is the one
 * place that knows every `funderId` in the corpus. This is the REAL organization behind each id
 * (not just a module's own `label`, which describes a scrape target, not a funder), researched
 * 2026-08-02. `crawl/runner.ts`'s `runSource` upserts the matching entry here before it does
 * anything else with a source, so a funder row exists before any review item from that source can
 * ever reach `approveReviewItem`.
 */
const FUNDERS: Readonly<Record<string, Funder>> = Object.freeze({
  ardc: {
    id: 'ardc',
    name: 'Amateur Radio Digital Communications (ARDC)',
    homepage: 'https://www.ardc.net/',
    ein: '45-3751971',
  },
  'arrl-foundation': {
    id: 'arrl-foundation',
    name: 'ARRL Foundation',
    homepage: 'https://www.arrl.org/arrl-foundation',
  },
  arrl: {
    id: 'arrl',
    name: 'American Radio Relay League (ARRL)',
    homepage: 'https://www.arrl.org/',
  },
  qcwa: {
    id: 'qcwa',
    name: 'Quarter Century Wireless Association (QCWA)',
    homepage: 'https://www.qcwa.org/',
  },
  ylrl: {
    id: 'ylrl',
    name: "Young Ladies' Radio League (YLRL)",
    homepage: 'https://ylrl.net/',
  },
  'austin-arc': {
    id: 'austin-arc',
    name: 'Austin Amateur Radio Club',
    homepage: 'https://austinhams.org/',
  },
  sara: {
    id: 'sara',
    name: 'Society of Amateur Radio Astronomers (SARA)',
    homepage: 'https://www.radio-astronomy.org/',
  },
  ncdxf: {
    id: 'ncdxf',
    name: 'Northern California DX Foundation (NCDXF)',
    homepage: 'https://www.ncdxf.org/',
  },
  'ariss-usa': {
    id: 'ariss-usa',
    name: 'Amateur Radio on the International Space Station — USA (ARISS-USA)',
    homepage: 'https://ariss-usa.org/',
  },
  'ieee-mtts': {
    id: 'ieee-mtts',
    name: 'IEEE Microwave Theory and Technology Society (MTT-S)',
    homepage: 'https://mtt.org/',
  },
  ieee: {
    id: 'ieee',
    name: 'Institute of Electrical and Electronics Engineers (IEEE)',
    homepage: 'https://www.ieee.org/',
  },
  nasa: {
    id: 'nasa',
    name: 'National Aeronautics and Space Administration (NASA)',
    homepage: 'https://www.nasa.gov/',
  },
  'yaesu-usa': {
    id: 'yaesu-usa',
    name: 'Yaesu USA',
    homepage: 'https://www.yaesu.com/',
    note: 'The System Fusion DR-2X repeater program itself is administered at systemfusion.yaesu.com.',
  },
  nsf: {
    id: 'nsf',
    name: 'National Science Foundation (NSF)',
    homepage: 'https://www.nsf.gov/',
  },
  federal: {
    id: 'federal',
    name: 'U.S. Federal Government (Grants.gov / USAspending)',
    homepage: 'https://www.grants.gov/',
    note:
      'One funder row for the three Tier A adjacency-scored modules that all declare ' +
      'funderId "federal": grants-gov-federal and grants-gov-extract poll Grants.gov, the ' +
      'cross-agency discovery portal; usaspending polls USAspending.gov, the awarded-spending ' +
      'transparency portal. Neither site is itself a grantmaker — every record names its real ' +
      'awarding federal agency in the program text.',
  },
  various: {
    id: 'various',
    name: 'Various hand-curated organizations (Tier D manual records)',
    homepage: 'https://www.yasme.org/',
    note:
      'manual-tier-d is one SourceModule covering 16 hand-researched records for organizations ' +
      'that cannot safely be polled or were confirmed NOT to be grantmakers: the Yasme ' +
      'Foundation, the Radio Club of America, NASA’s 52 state Space Grant Consortia, campus ' +
      'student-government funding, the NCDXF Youth Grant stub, HamSCI, ~39 IEEE society pages, ' +
      'and six verified-negative research notes (AMSAT, FlexRadio, Icom/DX Engineering/Kenwood, ' +
      'DARA/Hamvention, Chicago FM Club) plus the FAR domain-compromise safety warning. No ' +
      'single organization homepage covers this bucket; yasme.org is used as a representative ' +
      'anchor because it is the most consequential organization in the set. See ' +
      'sources/manual-tier-d.ts for the full per-record sourceUrl list.',
  },
});

/**
 * Real-world funder identity for a module's `funderId`. Throws for an id with no entry above — a
 * new SourceModule that ships without a matching FUNDERS entry must fail loudly on its own first
 * crawl (caught by `runSource`'s existing try/catch and recorded as a source health failure) with
 * a message that names the missing id, rather than let a much later `approveReviewItem` call die
 * on an opaque `FOREIGN KEY constraint failed` with no clue why.
 */
export function funderFor(funderId: string): Funder {
  const found = FUNDERS[funderId];
  if (!found) {
    throw new Error(
      `no funder registered for funderId "${funderId}" — add it to FUNDERS in sources/registry.ts`,
    );
  }
  return found;
}
