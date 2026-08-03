import { describe, expect, it } from 'vitest';
import { fixturePayload, hasFixture, loadFixture } from '../../test/fixtures.js';
import {
  arrlScholarshipDescriptions,
  parseScholarshipCatalog,
} from './arrl-scholarship-descriptions.js';

const SOURCE_ID = 'arrl-scholarship-descriptions';
const URL = 'http://www.arrl.org/scholarship-descriptions';
const LIVE = '00-www-arrl-org-scholarship-descriptions.html';

const pathological = () => parseScholarshipCatalog(loadFixture(SOURCE_ID, 'pathological.html'), URL);

describe('parseScholarshipCatalog against the pathological fixture', () => {
  it('reads exactly the four catalog accordions and excludes EXPLORE ARRL chrome', () => {
    const result = pathological();
    expect(result.accordionCount).toBe(4);
    const names = result.entries.map((e) => e.name);
    expect(names).not.toContain('Membership');
    expect(names).not.toContain('ARRL Store');
  });

  it('drops the stub entries and keeps the real ones', () => {
    const result = pathological();
    expect(result.stubCount).toBe(3);
    expect(result.entries).toHaveLength(6);
    expect(result.entries.map((e) => e.name)).toEqual([
      'ARDC Scholarships',
      'Challenge Met Scholarship',
      'Edmond A. Metzger Scholarship',
      'Larry Hodges Memorial Scholarship',
      'QCWA Memorial Scholarship',
      'YASME Foundation Scholarship',
    ]);
  });

  it('reads the typo’d labels: "R egion", "License   Requirement", "Number of Scholarshps"', () => {
    const ardc = pathological().entries.find((e) => e.name === 'ARDC Scholarships');
    expect(ardc?.rawFields.Region).toContain('worldwide');
    expect(ardc?.rawFields['License Requirement']).toBe('Any class, licensed at least one year');
    expect(ardc?.rawFields['Number of Awards']).toBe('45');
  });

  it('parses a flat <p>• Label: value<br> body identically to a <ul><li><strong>…</strong></li> body', () => {
    const flat = pathological().entries.find((e) => e.name === 'Challenge Met Scholarship');
    expect(flat?.rawFields['Field of Study']).toBe('Any');
    expect(flat?.rawFields['Award Amount']).toBe('$1,000');
    expect(flat?.rawFields['Number of Awards']).toBe('1 per year');
    expect(flat?.rawFields.Other).toContain('diagnosed learning disability');
  });

  it('recovers fields from invalid HTML with a <ul> opened inside a <p>', () => {
    const metzger = pathological().entries.find((e) => e.name === 'Edmond A. Metzger Scholarship');
    expect(metzger?.rawFields['Field of Study']).toBe('Electrical Engineering');
    expect(metzger?.rawFields.Region).toBe('ARRL Central Division (IL, IN, WI)');
    expect(metzger?.rawFields.Age).toBe('17 to 25');
  });

  it('normalises \\xa0 out of every value', () => {
    for (const entry of pathological().entries) {
      for (const value of Object.values(entry.rawFields)) {
        expect(value).not.toContain(' ');
      }
    }
  });

  it('preserves the whole flattened entry verbatim in rawText', () => {
    const hodges = pathological().entries.find((e) => e.name === 'Larry Hodges Memorial Scholarship');
    expect(hodges?.rawText).toContain('If no qualified');
    expect(hodges?.rawText).toContain('at-risk-youth turnaround');
  });

  it('keeps the "Any, except for Liberal Arts" exclusion verbatim', () => {
    const hodges = pathological().entries.find((e) => e.name === 'Larry Hodges Memorial Scholarship');
    expect(hodges?.rawFields['Field of Study']).toBe('Any, except for Liberal Arts');
  });

  it('keeps the radius region verbatim so the geography extractor can read it', () => {
    const hodges = pathological().entries.find((e) => e.name === 'Larry Hodges Memorial Scholarship');
    expect(hodges?.rawFields.Region).toBe('Residing within 250 miles of Seaford, Delaware');
  });

  it('uses the scholarship name as a stable externalKey and stamps the sourceUrl', () => {
    const entry = pathological().entries[0];
    expect(entry.externalKey).toBe('ARDC Scholarships');
    expect(entry.sourceId).toBe(SOURCE_ID);
    expect(entry.sourceUrl).toBe(URL);
  });
});

describe('the SourceModule wrapper', () => {
  it('declares the contract fields the runner needs', () => {
    expect(arrlScholarshipDescriptions.id).toBe(SOURCE_ID);
    expect(arrlScholarshipDescriptions.tier).toBe('C');
    expect(arrlScholarshipDescriptions.klass).toBe('ham_scholarship');
    expect(arrlScholarshipDescriptions.expectedMinRecords).toBe(100);
    expect(arrlScholarshipDescriptions.requests).toEqual([
      { url: URL, method: 'GET', accept: 'html' },
    ]);
  });

  it('parses from a FetchedPayload array', () => {
    const payload = fixturePayload(SOURCE_ID, 'pathological.html', URL);
    expect(arrlScholarshipDescriptions.parse([payload])).toHaveLength(6);
  });

  it('returns [] rather than throwing when the payload is missing', () => {
    expect(arrlScholarshipDescriptions.parse([])).toEqual([]);
  });
});

describe.skipIf(!hasFixture(SOURCE_ID, LIVE))('against the captured live page', () => {
  it('finds four accordions and at least 100 real entries', () => {
    const result = parseScholarshipCatalog(loadFixture(SOURCE_ID, LIVE), URL);
    expect(result.accordionCount).toBe(4);
    expect(result.entries.length).toBeGreaterThanOrEqual(100);
  });

  it('names every entry and gives almost all of them a Field of Study', () => {
    const { entries } = parseScholarshipCatalog(loadFixture(SOURCE_ID, LIVE), URL);
    for (const e of entries) expect(e.name.length).toBeGreaterThan(2);
    const withField = entries.filter((e) => e.rawFields['Field of Study'] !== undefined);
    expect(withField.length / entries.length).toBeGreaterThan(0.9);
  });

  it('does not contain the discontinued Chicago FM Club Scholarship', () => {
    const { entries } = parseScholarshipCatalog(loadFixture(SOURCE_ID, LIVE), URL);
    expect(entries.map((e) => e.name).join('|')).not.toMatch(/Chicago FM Club/i);
  });
});
