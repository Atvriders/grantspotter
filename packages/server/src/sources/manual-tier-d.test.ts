import { describe, expect, it } from 'vitest';
import { TIER_D_RECORDS, manualTierD } from './manual-tier-d.js';

describe('manualTierD module', () => {
  it('is Tier D and fetches nothing', () => {
    expect(manualTierD.tier).toBe('D');
    expect(manualTierD.requests).toEqual([]);
  });

  it('returns the same records regardless of what it is handed', () => {
    expect(manualTierD.parse([])).toEqual([...TIER_D_RECORDS]);
    expect(manualTierD.parse([{ url: 'x', status: 200, contentType: '', body: '', fetchedAt: '' }])).toEqual(
      [...TIER_D_RECORDS],
    );
  });

  it('has at least 15 records and expectedMinRecords matches', () => {
    expect(TIER_D_RECORDS.length).toBeGreaterThanOrEqual(15);
    expect(manualTierD.expectedMinRecords).toBe(15);
  });

  it('gives every record a unique externalKey, a name and a verbatim rawText', () => {
    const keys = TIER_D_RECORDS.map((r) => r.externalKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const r of TIER_D_RECORDS) {
      expect(r.sourceId).toBe('manual-tier-d');
      expect(r.name.length).toBeGreaterThan(2);
      expect(r.rawText.length).toBeGreaterThan(20);
      expect(r.rawFields.recordType).toBeDefined();
    }
  });
});

describe('the FAR safety record', () => {
  const far = TIER_D_RECORDS.find((r) => r.externalKey === 'far-farweb-org-compromised');

  it('exists and is typed as a safety warning', () => {
    expect(far).toBeDefined();
    expect(far?.rawFields.recordType).toBe('safety_warning');
  });

  it('states the takeover, the window, and that other sites still send applicants there', () => {
    expect(far?.rawText).toMatch(/gambling/i);
    expect(far?.rawText).toMatch(/2025-10-17/);
    expect(far?.rawText).toMatch(/2026-02-10/);
    expect(far?.rawText).toMatch(/still (?:tell|instruct|point)/i);
  });

  it('does NOT contain a live link to the compromised domain', () => {
    expect(far?.sourceUrl).not.toContain('farweb.org');
    expect(far?.rawFields.sourceUrl).toBeUndefined();
  });

  it('records that FAR’s portfolio appears absorbed into the ARRL Foundation', () => {
    expect(far?.rawText).toMatch(/ARRL Foundation/);
  });
});

describe('the verified-negative records', () => {
  const negatives = TIER_D_RECORDS.filter((r) => r.rawFields.recordType === 'verified_negative');

  it('covers every §2.1 finding so nobody re-researches them', () => {
    const keys = negatives.map((r) => r.externalKey);
    expect(keys).toEqual(
      expect.arrayContaining([
        'negative-arrl-cari',
        'negative-amsat',
        'negative-flexradio',
        'negative-icom-dxengineering-kenwood',
        'negative-dara-hamvention',
        'negative-chicago-fm-club',
      ]),
    );
  });

  it('gives each negative a reason a human can act on', () => {
    for (const n of negatives) expect(n.rawFields.reason.length).toBeGreaterThan(20);
  });

  it('flags Chicago FM Club as a stale-mirror case', () => {
    const chicago = negatives.find((r) => r.externalKey === 'negative-chicago-fm-club');
    expect(chicago?.rawFields.staleMirrorWarning).toMatch(/aggregator/i);
  });
});

describe('the blocked-client records', () => {
  it('covers the five sites that block non-browser clients and says we do not spoof', () => {
    const keys = TIER_D_RECORDS.map((r) => r.externalKey);
    expect(keys).toEqual(
      expect.arrayContaining([
        'yasme-supporting-grants',
        'yasme-excellence-award',
        'rca-scholarship-program',
        'rca-youth-activities',
      ]),
    );
    const yasme = TIER_D_RECORDS.find((r) => r.externalKey === 'yasme-supporting-grants');
    expect(yasme?.rawFields.whyManual).toMatch(/403/);
    expect(yasme?.rawFields.whyManual).toMatch(/do not spoof/i);
  });

  it('records that Yasme has no application and no deadline at all', () => {
    const yasme = TIER_D_RECORDS.find((r) => r.externalKey === 'yasme-supporting-grants');
    expect(yasme?.rawFields.deadlineKind).toBe('no_application_exists');
  });

  it('records that RCA nominates rather than accepting student applications', () => {
    const rca = TIER_D_RECORDS.find((r) => r.externalKey === 'rca-scholarship-program');
    expect(rca?.rawText).toMatch(/university selects/i);
    expect(rca?.rawFields.applicantEntity).toBe('nominated_by_institution');
  });
});

describe('the non-aggregatable guided-workflow records', () => {
  it('ships NASA Space Grant and campus SGA as standing records', () => {
    const keys = TIER_D_RECORDS.map((r) => r.externalKey);
    expect(keys).toEqual(
      expect.arrayContaining(['nasa-space-grant-consortia', 'campus-sga-playbook']),
    );
  });

  it('carries the FSU capital-equipment trap, which is the most valuable advice in the corpus', () => {
    const sga = TIER_D_RECORDS.find((r) => r.externalKey === 'campus-sga-playbook');
    expect(sga?.rawText).toMatch(/capital equipment/i);
    expect(sga?.rawText).toMatch(/programming/i);
  });

  it('records that there is no national Space Grant deadline', () => {
    const sg = TIER_D_RECORDS.find((r) => r.externalKey === 'nasa-space-grant-consortia');
    expect(sg?.rawText).toMatch(/52/);
    expect(sg?.rawFields.deadlineKind).toBe('unpublished');
  });
});
