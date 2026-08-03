import type { RawOpportunity, SourceModule } from '@grantspotter/core';
import { parseDateRange } from './util/dates.js';
import { type SinglePageConfig, makeSinglePageSource } from './util/singlePage.js';

/** ARISS rewrites one window sentence quarterly at a stable URL. Both ends or nothing. */
export function parseArissWindow(
  flatText: string,
): { opensAt?: string; closesAt?: string } | undefined {
  const sentence = /proposal window[^.]*\./i.exec(flatText)?.[0];
  if (!sentence) return undefined;
  return parseDateRange(sentence);
}

const CONFIGS: SinglePageConfig[] = [
  {
    id: 'ncdxf-grants',
    funderId: 'ncdxf',
    label: 'NCDXF Grant Program',
    tier: 'C',
    klass: 'ham_grant',
    url: 'https://www.ncdxf.org/pages/grant-app.html',
    name: 'NCDXF Grant Program',
    externalKey: 'ncdxf-grant-program',
    fieldPatterns: {
      audience: /(individuals? and groups[^.]*\.)/i,
      leadTime: /(two months[^.]*\.)/i,
      applyNote: /([^.]*treasurer[^.]*\.)/i,
      stake: /([^.]*financial stake[^.]*\.)/i,
    },
    requiredFields: ['applyNote'],
    expectedMinRecords: 1,
    notes:
      'Rolling, allow ~2 months lead. In practice DXpedition teams to top-100 DXCC entities — ' +
      'NOT a collegiate program, and the record says so rather than implying eligibility. ' +
      'Amounts unpublished (~$1.2M over ~48 years, so many small awards). Applicant must have ' +
      'a personal financial stake. Apply by emailing a form + budget spreadsheet to the ' +
      'treasurer. ncdxf.org 403s BOTH its robots.txt and its sitemap.xml; the fetcher treats a ' +
      '403 robots.txt as "no rules published", which is what keeps this source reachable ' +
      'without spoofing a browser.',
  },
  {
    id: 'ncdxf-scholarships',
    funderId: 'ncdxf',
    label: 'NCDXF W6EEN Memorial Scholarship and Youth Grant',
    tier: 'C',
    klass: 'ham_scholarship',
    url: 'https://www.ncdxf.org/pages/scholarships.html',
    name: 'NCDXF W6EEN Memorial Scholarship',
    externalKey: 'ncdxf-w6een-scholarship',
    fieldPatterns: {
      age: /(25 (?:years )?or (?:younger|under)[^.]*\.)/i,
      benefit: /([^.]*tuition[^.]*\.)/i,
    },
    requiredFields: ['benefit'],
    expectedMinRecords: 1,
    notes:
      'Licensed hams 25 or younger, any class. Benefit is full tuition at DX University or ' +
      'Contest University with no dollar figure, so the instrument is tuition_coverage. No ' +
      'published deadlines — it tracks course schedules, so DeadlineKind is unpublished. The ' +
      'companion Youth Grant page renders as nav + title only with no terms at all.',
  },
  {
    id: 'ariss',
    funderId: 'ariss-usa',
    label: 'ARISS-USA ISS Contact Proposals',
    tier: 'C',
    klass: 'equipment_in_kind',
    url: 'https://ariss-usa.org/proposal-overview/',
    name: 'ARISS-USA ISS Contact Proposal',
    externalKey: 'ariss-iss-contact-proposal',
    fieldPatterns: { window: /(proposal window[^.]*\.)/i },
    requiredFields: ['window'],
    expectedMinRecords: 1,
    extraParse: (): RawOpportunity[] => [],
    notes:
      'No cash at all: a scheduled ISS crew contact plus technical mentoring, so the instrument ' +
      'is in_kind_service. Four windows a year, rewritten quarterly at a STABLE URL, which ' +
      'makes it one of the better scrape targets in the corpus. Eligibility reads "US schools ' +
      'and educational organizations" — colleges and universities are NOT explicitly named and ' +
      'K-12 dominates; that ambiguity is preserved in rawOtherText and never resolved by ' +
      'guessing.',
  },
  {
    id: 'ieee-mtts',
    funderId: 'ieee-mtts',
    label: 'IEEE MTT-S Chapter Support',
    tier: 'C',
    klass: 'adjacent_stem',
    url: 'https://mtt.org/chapter-support/',
    name: 'IEEE MTT-S Chapter Support',
    externalKey: 'ieee-mtts-chapter-support',
    fieldPatterns: {
      deadline: /(due October 1[^.]*\.)/i,
      amount: /([^.]*\$1,000[^.]*\.)/i,
      requirements: /([^.]*five members[^.]*\.)/i,
    },
    requiredFields: ['deadline'],
    expectedMinRecords: 1,
    notes:
      'The most RF-relevant IEEE money. Oct 1 annual, stated inline. $1,000/yr single-society ' +
      'Student Branch Chapter, $500 joint; plus 10 x $1,500 undergraduate scholarships and ' +
      '3 x $6,000 fellowships. Requires >= 5 members, a current vTools officer roster and >= 2 ' +
      'reported meetings. Jotform application.',
  },
  {
    id: 'ieee-student-branch-rebate',
    funderId: 'ieee',
    label: 'IEEE Student Branch Rebate',
    tier: 'C',
    klass: 'adjacent_stem',
    url: 'https://students.ieee.org/topics/submit-your-student-branch-annual-plan/',
    name: 'IEEE Student Branch Rebate',
    externalKey: 'ieee-student-branch-rebate',
    fieldPatterns: { deadline: /((?:15 March|March 15)[^.]*\.)/i },
    requiredFields: ['deadline'],
    expectedMinRecords: 1,
    notes:
      'Annual Plan due 15 March. Instrument is per_member_rebate: $50/yr under 50 members, ' +
      '$100/yr at 50+, plus $2/member and $1/chapter member. The amounts page ' +
      'mga.ieee.org/.../rebates returns HTTP 418 to bots, so those figures are ' +
      'search-snippet-sourced and the record ships with lower confidence. We do not spoof a ' +
      'browser to read it.',
  },
  {
    id: 'nasa-csli',
    funderId: 'nasa',
    label: 'NASA CubeSat Launch Initiative',
    tier: 'C',
    klass: 'equipment_in_kind',
    url: 'https://www.nasa.gov/kennedy/launch-services-program/cubesat-launch-initiative/',
    name: 'NASA CubeSat Launch Initiative (CSLI)',
    externalKey: 'nasa-csli',
    fieldPatterns: {
      status: /((?:anticipates?|expects?)[^.]*\d{4}[^.]*\.)/i,
      benefit: /([^.]*launch[^.]*services[^.]*\.)/i,
    },
    requiredFields: ['benefit'],
    expectedMinRecords: 1,
    notes:
      'No cash: launch and deployment services only; the team funds its own hardware, so the ' +
      'instrument is in_kind_service. Historically an August release with a November due date, ' +
      'but the page currently says NASA "anticipates an update in spring 2026" — there is NO ' +
      'confirmed open window, so status: unknown is the honest rendered state. NSPIRES has no ' +
      'API, RSS, XML, JSON or CSV (session-stateful Struts/JSF .do app); Grants.gov is the only ' +
      'machine route to NASA opportunities.',
  },
];

const modules = CONFIGS.map(makeSinglePageSource);

/** ARISS additionally resolves its window sentence into ISO dates for normalize/. */
function withArissDates(module: SourceModule): SourceModule {
  const inner = module.parse.bind(module);
  return {
    ...module,
    parse: (payloads) =>
      inner(payloads).map((raw) => {
        const range = parseArissWindow(raw.rawText);
        if (!range?.opensAt || !range.closesAt) return raw;
        return {
          ...raw,
          rawFields: { ...raw.rawFields, opensAt: range.opensAt, closesAt: range.closesAt },
        };
      }),
  };
}

export const ncdxfGrants = modules[0];
export const ncdxfScholarships = modules[1];
export const ariss = withArissDates(modules[2]);
export const ieeeMtts = modules[3];
export const ieeeStudentBranchRebate = modules[4];
export const nasaCsli = modules[5];

export const TIER_C_B_SOURCES: SourceModule[] = [
  ncdxfGrants,
  ncdxfScholarships,
  ariss,
  ieeeMtts,
  ieeeStudentBranchRebate,
  nasaCsli,
];
