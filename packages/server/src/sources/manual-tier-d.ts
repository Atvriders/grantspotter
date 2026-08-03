import type { RawOpportunity, SourceModule } from '@grantspotter/core';

const SOURCE_ID = 'manual-tier-d';

function record(
  externalKey: string,
  name: string,
  sourceUrl: string,
  rawFields: Record<string, string>,
  rawText: string,
): RawOpportunity {
  return { sourceId: SOURCE_ID, externalKey, name, rawFields, sourceUrl, rawText };
}

/**
 * Hand-curated records for sources that cannot or must not be polled. Verified 2026-08-02;
 * re-verify quarterly. Every record still flows through the normal pipeline — it normalizes,
 * it diffs, it ages, it goes amber past 90 days, and "Verify now" works on it.
 *
 * Plan 5's data/seed/*.json corpus (~150 records) must dedupe against these externalKeys and
 * must not restate them.
 *
 * FIX ROUND 2 (Task 15/16 review): every record below carries an explicit `rawFields.status`.
 * `normalize/deadline.ts`'s `inferStatus` reads this as an override BEFORE it tries to infer
 * anything from `recordType`/`deadlineKind`, so the correct status for a hand-researched record is
 * a fact stated here, not a guess reconstructed later from a generic recordType bucket. Getting
 * this wrong is not cosmetic: `'discontinued'` on `verified_negative` records for AMSAT, ARRL CARI,
 * FlexRadio and DARA/Hamvention used to claim four ACTIVE organizations had shut down, and `'open'`
 * on four contact-only/pointer records used to claim they were live application-ready
 * opportunities. `status` is one of the seven `ProgramStatus` values (`open`, `closed`, `dormant`,
 * `discontinued`, `contact_only`, `no_application`, `unknown`) — see `normalize/index.test.ts`'s
 * exhaustive per-record status table for the reasoning behind each of the 16 below.
 */
export const TIER_D_RECORDS: readonly RawOpportunity[] = Object.freeze([
  record(
    'far-farweb-org-compromised',
    'Foundation for Amateur Radio (FAR) — domain compromised, do not apply',
    'https://www.arrl.org/scholarship-program',
    // The FAR intake this record intercepts is genuinely dead — the domain was taken over, and
    // FAR's historical portfolio was absorbed elsewhere — so 'discontinued' is correct here.
    { recordType: 'safety_warning', status: 'discontinued' },
    'SAFETY WARNING. The Foundation for Amateur Radio’s domain no longer belongs to FAR: it ' +
      'now redirects to an Indonesian online-gambling site. Wayback pins the takeover between ' +
      '2025-10-17 and 2026-02-10. QCWA pages, ARRL pages and club pages still tell applicants ' +
      'to "apply at the FAR website", so this record exists to intercept that instruction. Do ' +
      'not visit the domain. FAR’s historical portfolio (10-10, QCWA, YASME, K3IVO, CARA) ' +
      'appears absorbed into the ARRL Foundation — apply through the ARRL Foundation ' +
      'scholarship application instead. The domain is hard-blocklisted in the fetcher and no ' +
      'link to it appears anywhere in this application.',
  ),
  record(
    'yasme-supporting-grants',
    'Yasme Foundation Supporting Grants',
    'https://www.yasme.org/news-releases/',
    {
      recordType: 'manual',
      status: 'no_application',
      deadlineKind: 'no_application_exists',
      whyManual:
        'yasme.org 301s /feed/ and /wp-json/ to a 403 page for non-browser clients and a ' +
        'browser-UA curl hits a redirect loop. We do not spoof a browser to defeat a ' +
        'deliberate access policy. Tracked instead through the ARRL news RSS feed, which ' +
        'relays Yasme announcements.',
    },
    'Board-initiated grants of roughly $5,000 to $7,500 to youth programs, developing-country ' +
      'societies, Reverse Beacon Network nodes and other foundations’ scholarship funds. There ' +
      'is no application and no deadline: the board selects recipients and announces them ' +
      'retrospectively about twice a year. A year-end activity report is expected of ' +
      'recipients.',
  ),
  record(
    'yasme-excellence-award',
    'Yasme Excellence Award',
    'https://www.yasme.org/news-releases/',
    {
      recordType: 'manual',
      status: 'no_application',
      deadlineKind: 'no_application_exists',
      whyManual: 'See yasme-supporting-grants: yasme.org 403s non-browser clients and we do not spoof.',
    },
    'Board-selected recognition award announced retrospectively. There is no application path ' +
      'and no deadline. Listed so a user searching for Yasme finds an accurate answer instead ' +
      'of a dead application link.',
  ),
  record(
    'rca-scholarship-program',
    'Radio Club of America Scholarship Program',
    'https://www.radioclubofamerica.org/',
    {
      recordType: 'manual',
      status: 'contact_only',
      applicantEntity: 'nominated_by_institution',
      deadlineKind: 'unpublished',
      whyManual:
        'radioclubofamerica.org runs ClubExpress: sitemap.xml 403s, WebFetch 403s, pretty URLs ' +
        '404, and only content.aspx query-string URLs work — and only with a browser UA, which ' +
        'we do not send. It also breaks silently whenever RCA renumbers a module id.',
    },
    'Rappaport, Carr, Cooper and 13 further named funds for undergraduate and graduate students ' +
      'on a wireless career track. A ham licence is NOT required. Only students at roughly nine ' +
      'participating schools are eligible, and the university selects recipients — the student ' +
      'never applies to RCA. Per-award amounts are unpublished; about $15,000 a year is ' +
      'distributed in total, each May. The action for a student is to ask their department ' +
      'whether their school participates.',
  ),
  record(
    'rca-youth-activities',
    'Radio Club of America Youth Activities Program',
    'https://www.radioclubofamerica.org/',
    {
      recordType: 'manual',
      status: 'contact_only',
      deadlineKind: 'rolling',
      whyManual: 'ClubExpress module_id query strings only; see rca-scholarship-program.',
    },
    'In-kind support only — books, equipment and curriculum for schools, scouting groups and ' +
      'museums. No cash, no published deadline. Permanent contact-only entry; do not poll.',
  ),
  record(
    'nasa-space-grant-consortia',
    'NASA National Space Grant — 52 state consortia',
    'https://www.nasa.gov/learning-resources/national-space-grant-college-and-fellowship-project/',
    { recordType: 'guided_workflow', status: 'contact_only', deadlineKind: 'unpublished' },
    'The most common real route to a campus ground station or cubesat, and structurally ' +
      'non-aggregatable: 52 independent consortia, 52 independent calendars, no national ' +
      'deadline, and heterogeneous university-hosted sites. Consortium-level student awards are ' +
      'typically $1,000 to $10,000 and are not published nationally. GrantSpotter ships this as ' +
      'a state-keyed consortium picker (Plan 3) rather than pretending it is a feed.',
  ),
  record(
    'campus-sga-playbook',
    'Campus student government / student activity fee funding',
    'https://sga.fsu.edu/accounting/funding-your-rso',
    { recordType: 'guided_workflow', status: 'contact_only', deadlineKind: 'rolling' },
    'Where a typical collegiate club’s money actually comes from, and impossible to aggregate: ' +
      'roughly 4,000 campuses on Qualtrics, CampusGroups, Presence and Engage. The ham club ' +
      'applies like any other registered student organization. FSU, taken as representative: ' +
      'programming up to $3,000 (up to $5,000 extraordinary), travel $250 per student and ' +
      '$5,000 per organization, Development Fund up to $300 per fiscal year, with a rolling ' +
      'event and travel process needing at least six weeks’ lead and a maximum of three ' +
      'requests per year, plus an annual A&S budget cycle. THE TRAP: capital equipment is ' +
      'frequently barred outright by student-activity-fee rules, so a radio must be framed as ' +
      'programming or funded externally. That framing advice is worth more than most of the ' +
      'opportunity index.',
  ),
  record(
    'ncdxf-youth-grant',
    'NCDXF Youth Grant',
    'https://www.ncdxf.org/pages/scholarships.html',
    { recordType: 'manual', status: 'contact_only', deadlineKind: 'unpublished' },
    'The Youth Grant page renders as navigation and a title only — it publishes no terms, no ' +
      'amount and no deadline. Recorded as a contact-only entry so the app gives an honest ' +
      'answer instead of an empty page. Low-value polling target; also part of why ncdxf.org ' +
      'is a Tier D site (robots.txt and sitemap.xml both 403 non-browser clients).',
  ),
  record(
    'hamsci-participation',
    'HamSCI — participate with a funded principal investigator',
    'https://hamsci.org/',
    { recordType: 'manual', status: 'no_application', deadlineKind: 'no_application_exists' },
    'HamSCI has no club-facing application. It is a research collaboration funded by NSF ' +
      'awards held by university PIs (for example the Personal Space Weather Station network ' +
      'and the Scranton CAREER award on amateur radio and travelling ionospheric ' +
      'disturbances). A collegiate club participates by contacting a funded PI, not by ' +
      'applying for a grant.',
  ),
  record(
    'ieee-society-funding-pages',
    'IEEE society funding pages (~39 societies)',
    'https://www.ieee.org/communities/societies/',
    { recordType: 'manual', status: 'contact_only', deadlineKind: 'unpublished' },
    'Roughly 39 IEEE societies each publish their own chapter and student funding page on ' +
      'different templates and calendars, and mga.ieee.org itself returns HTTP 418 to bots. ' +
      'MTT-S is polled directly because it is the most RF-relevant; the rest are a ' +
      'hand-curated pointer so a student branch knows to check their own society.',
  ),
  record(
    'negative-arrl-cari',
    'ARRL Collegiate Amateur Radio Initiative (CARI) — not a funding program',
    'http://www.arrl.org/cari',
    {
      recordType: 'verified_negative',
      // 'discontinued' would be false: CARI is running right now (Zoom meetups, the Collegiate
      // QSO Party, Hamvention networking). It was never a funding program, so there is simply
      // nothing to apply to — that is 'no_application', not "this used to exist and ended".
      status: 'no_application',
      reason:
        'CARI is Zoom meetups, the Collegiate QSO Party and Hamvention networking. It is not a ' +
        'funding program. The W1YSM Snyder endowment funds CARI activities but has no open ' +
        'application. Confirmed independently by two researchers on 2026-08-02.',
    },
    'Recorded as a verified negative so a future maintainer does not re-research it and so the ' +
      'UI never renders an empty "CARI grants" category.',
  ),
  record(
    'negative-amsat',
    'AMSAT — no grants program',
    'https://www.amsat.org/university-participation/',
    {
      recordType: 'verified_negative',
      // AMSAT is thriving — it is simply not a grantmaker. 'discontinued' would tell a student
      // that an active organization has shut down, which is false.
      status: 'no_application',
      reason:
        'AMSAT is a grant RECIPIENT (via ARISS/ARDC), not a grantmaker. /university-participation/ ' +
        'is a near-empty stub listing one RIT project. Confirmed by two researchers.',
    },
    'Recorded as a verified negative. Students searching for "AMSAT grant" get an accurate ' +
      'answer instead of an empty result.',
  ),
  record(
    'negative-flexradio',
    'FlexRadio — no education or nonprofit purchasing tier',
    'https://www.flexradio.com/purchasing-programs/',
    {
      recordType: 'verified_negative',
      // FlexRadio exists and sells radios; it just has no education/nonprofit tier to apply to.
      status: 'no_application',
      reason:
        'The purchasing-programs page was fetched directly to check. Only a CPO programme and ' +
        'a trade-in exist; there is no education, student, club or nonprofit purchasing tier.',
    },
    'Recorded as a verified negative so the equipment category does not imply a discount that ' +
      'does not exist.',
  ),
  record(
    'negative-icom-dxengineering-kenwood',
    'Icom America, DX Engineering, Kenwood — relationship-driven, no application path',
    'https://www.icomamerica.com/',
    {
      recordType: 'verified_negative',
      // Real giving happens through a person (the regional rep), not a form — 'contact_only',
      // not 'discontinued': these vendors are actively giving equipment right now.
      status: 'contact_only',
      reason:
        'Genuine collegiate giving happens — IC-7610s reached CMU W3VC, Penn State K3CR and ' +
        'Pitt W3YI — but there is no application programme, no page and no deadline. Kenwood ' +
        'has nothing at all. Never ship this as an opportunity with a fake deadline.',
    },
    'Shipped as a relationship playbook rather than an opportunity: identify the regional rep, ' +
      'lead with the students and the on-air result, and ask for a specific model. There is no ' +
      'form to fill in.',
  ),
  record(
    'negative-dara-hamvention',
    'DARA / Hamvention — grantmaker only through the ARRL catalog',
    'https://hamvention.org/',
    {
      recordType: 'verified_negative',
      // The real DARA scholarship lives inside the ARRL catalog as its own program; THIS record
      // is "there is no separate DARA/Hamvention-hosted application" — no_application, not
      // discontinued (Hamvention itself is an active, ongoing event).
      status: 'no_application',
      reason:
        'Zero hrefs containing "scholar" or "grant" on w8bi.org; hamvention.org has no ' +
        'scholarship page; daytonhamvention.org did not resolve. Only the DARA entry inside ' +
        'the ARRL catalog is real ($1,500, multiple per year, any licence class).',
    },
    'Apply through the ARRL Foundation scholarship application. Do not look for a DARA-hosted ' +
      'form; none exists.',
  ),
  record(
    'negative-chicago-fm-club',
    'Chicago FM Club Scholarship — discontinued',
    'https://www.chicagofmclub.org/',
    {
      recordType: 'verified_negative',
      // The one negative record that is genuinely 'discontinued': the scholarship really did end
      // (0 hits in the live ARRL catalog), which is also why it carries a stale-mirror warning.
      status: 'discontinued',
      reason:
        'Zero hits in the live ARRL scholarship catalog, and 325 KB of chicagofmclub.org ' +
        'contains no occurrence of the word "scholarship".',
      staleMirrorWarning:
        'Still listed by seven or more third-party aggregators — direct proof that they mirror ' +
        'stale ARRL data rather than re-reading the source.',
    },
    'Recorded as discontinued with an explicit stale-mirror warning, because a student who ' +
      'finds it on an aggregator needs to be told why it is not in the live catalog.',
  ),
]);

export const manualTierD: SourceModule = {
  id: SOURCE_ID,
  funderId: 'various',
  label: 'Manually curated Tier D records',
  tier: 'D',
  klass: 'ham_grant',
  requests: [],
  expectedMinRecords: 15,
  notes:
    'No network access at all. Covers the five sites that deliberately block non-browser ' +
    'clients (yasme.org 403, ncdxf.org robots+sitemap 403, radioclubofamerica.org 403, ' +
    'mga.ieee.org HTTP 418, k9ona.com 403) — each worth 1-2 records a human curates in five ' +
    'minutes and re-verifies quarterly, and none worth spoofing a browser for. Also carries ' +
    'the two structurally non-aggregatable guided workflows (52 NASA Space Grant consortia, ' +
    '~4,000 campus SGAs), the verified negatives so nobody re-researches them, and the FAR ' +
    'safety warning. Plan 5 seed data must dedupe against these externalKeys.',
  parse(): RawOpportunity[] {
    return [...TIER_D_RECORDS];
  },
};
