/**
 * THE VERIFIED NEGATIVES, THE FAR SAFETY WARNING, AND THE ONE DISPUTED RECORD.
 *
 * Six things in this space look like funding programmes and are not. Each was checked by live
 * fetch in the 2026-08-02 research pass and each ships as an explicit record with a terminal
 * status, so a search for "AMSAT grant" or "CARI funding" returns the finding rather than
 * nothing. An empty result set reads as "GrantSpotter is incomplete"; a record that says *AMSAT
 * has no grants programme, here is what was checked* reads as "GrantSpotter did the work".
 *
 * The FAR record is a safety feature, not an index entry. The Foundation for Amateur Radio's
 * domain 301s to an Indonesian gambling site, and QCWA, ARRL and club pages still tell applicants
 * to apply there. `assertNotBlocked` catches a link on that host; it cannot see the host buried in
 * a text field, which is why the string check below exists as well.
 */
import { describe, expect, it } from 'vitest';
import { assertNotBlocked, BLOCKED_HOSTS } from '../fetcher/blocklist.js';
import { loadSeedCorpus, seedDir } from './load.js';

const corpus = loadSeedCorpus(seedDir());
const byId = new Map(corpus.programs.map((p) => [p.id, p]));

const REQUIRED_NEGATIVES = [
  'arrl-cari-not-a-funding-program',
  'amsat-no-grants-program',
  'flexradio-no-education-tier',
  'vendor-equipment-relationship-playbook',
  'dara-grantmaker-only-via-arrl',
  'chicago-fm-club-scholarship-discontinued',
  'far-domain-compromised',
];

describe('verified negatives', () => {
  it('ships every negative record the research established', () => {
    for (const id of REQUIRED_NEGATIVES) {
      expect(byId.has(id), `missing negative record ${id}`).toBe(true);
    }
  });

  it('gives every negative a terminal status and no false deadline', () => {
    for (const id of REQUIRED_NEGATIVES) {
      const program = byId.get(id)!;
      expect(['discontinued', 'no_application', 'contact_only', 'unknown']).toContain(program.trust.status);
      expect(['no_application_exists', 'dormant', 'unpublished', 'rolling']).toContain(program.deadline.kind);
    }
  });

  it('makes every negative searchable by the name a user would type', () => {
    const searchable = (needle: string): boolean =>
      corpus.programs.some((p) =>
        `${p.name} ${p.summary} ${p.tags.join(' ')}`.toLowerCase().includes(needle.toLowerCase()));
    for (const needle of ['CARI', 'AMSAT', 'FlexRadio', 'Icom', 'DX Engineering', 'Kenwood', 'Hamvention', 'Chicago FM Club', 'Foundation for Amateur Radio']) {
      expect(searchable(needle), `not searchable: ${needle}`).toBe(true);
    }
  });
});

describe('the FAR safety record', () => {
  const far = byId.get('far-domain-compromised')!;

  it('exists, is discontinued, and has no application path', () => {
    expect(far.trust.status).toBe('discontinued');
    expect(far.applyVia).toBe('none');
    expect(far.applyUrl).toBeUndefined();
  });

  it('explains the compromise, the takeover window and where the portfolio went', () => {
    const text = `${far.summary} ${far.rawOtherText} ${far.trust.staleMirrorWarning ?? ''}`;
    expect(text).toContain('gambling');
    expect(text).toContain('2025-10-17');
    expect(text).toContain('2026-02-10');
    expect(text).toContain('ARRL Foundation');
  });

  it('links nowhere near the compromised domain, in any field of any record', () => {
    const urls: string[] = [];
    for (const funder of corpus.funders) urls.push(funder.homepage);
    for (const program of corpus.programs) {
      urls.push(program.trust.sourceUrl, program.applyUrl ?? '', program.aiPolicy.url ?? '');
      for (const claim of program.trust.disputed?.claims ?? []) urls.push(claim.sourceUrl);
    }
    for (const url of urls) {
      expect(url).not.toContain('farweb');
      expect(url).not.toContain('batualam');
    }
  });

  it('warns that third parties still send applicants to the dead domain', () => {
    expect(far.trust.staleMirrorWarning ?? '').toMatch(/QCWA|ARRL|club pages/);
  });
});

describe('the ARRL Club Grant disputed record', () => {
  const club = byId.get('arrl-club-grant')!;

  it('ships with disputed populated and a status that does not pretend to know', () => {
    expect(club.trust.disputed).toBeDefined();
    expect(club.trust.status).toBe('unknown');
    expect(club.deadline.kind).toBe('dormant');
  });

  it('records all three researcher readings, each with its own source', () => {
    const claims = club.trust.disputed!.claims;
    expect(claims.length).toBe(3);
    for (const claim of claims) {
      expect(claim.claim.length).toBeGreaterThan(10);
      expect(claim.sourceUrl.startsWith('http')).toBe(true);
    }
    const joined = claims.map((c) => c.claim).join(' ');
    expect(joined).toMatch(/dormant/i);
    expect(joined).toMatch(/autumn|November/i);
    expect(joined).toMatch(/February/i);
  });

  it('keeps the real, verified facts about the programme intact', () => {
    expect(club.amount.amountMin).toBe(1000);
    expect(club.amount.amountMax).toBe(25000);
    expect(club.summary).toContain('$500,502');
  });
});

describe('the Chicago FM Club stale-mirror record', () => {
  const chicago = byId.get('chicago-fm-club-scholarship-discontinued')!;

  it('is marked discontinued and says how many aggregators still list it', () => {
    expect(chicago.trust.status).toBe('discontinued');
    expect(chicago.trust.staleMirrorWarning ?? '').toContain('aggregator');
  });
});

describe('the blocklist backs up the FAR record', () => {
  it('lists the compromised domain and every commercial aggregator', () => {
    for (const host of ['farweb.org', 'candid.org', 'fconline.foundationcenter.org', 'grantwatch.com', 'grantstation.com', 'instrumentl.com']) {
      expect(BLOCKED_HOSTS).toContain(host);
    }
  });

  it('throws for the compromised domain on any scheme, subdomain or path', () => {
    for (const url of ['https://farweb.org/', 'http://www.farweb.org/scholarships', 'https://FARWEB.ORG/apply']) {
      expect(() => assertNotBlocked(url)).toThrow();
    }
  });
});

/**
 * THE RULE THE HOST BLOCKLIST CANNOT ENFORCE. `assertNotBlocked` parses a URL and compares its
 * host; it never sees `farweb.org` written into a summary, a note or a stale-mirror warning. The
 * seed harness has a `blocked-host-in-prose` rule for exactly that, and it exempts records tagged
 * `safety_warning` — because a record whose whole purpose is to warn about a hijacked domain has
 * to be allowed to name it. This asserts the other half: that the exemption is used ONCE, by the
 * record that earns it, and that no other seed record names a blocklisted host in its prose.
 */
describe('a blocklisted domain appears in prose only where it is being warned about', () => {
  it('is named by the FAR record and by nothing else', () => {
    const namers: string[] = [];
    for (const program of corpus.programs) {
      const text = [
        program.name,
        program.summary,
        program.rawOtherText,
        program.deadline.note,
        program.trust.staleMirrorWarning ?? '',
        ...program.fundingRestrictions,
        ...program.constraints.map((c) => c.rawText),
      ]
        .join('\n')
        .toLowerCase();
      if (BLOCKED_HOSTS.some((host) => text.includes(host))) namers.push(program.id);
    }
    expect(namers).toEqual(['far-domain-compromised']);
    expect(byId.get('far-domain-compromised')!.tags).toContain('safety_warning');
  });
});
