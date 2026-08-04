import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConsortia, pickConsortium, referenceRoot } from './consortia.js';

const all = loadConsortia();

describe('space grant consortia reference data', () => {
  it('covers all 50 states plus DC and Puerto Rico', () => {
    expect(all.length).toBe(52);
    const codes = new Set(all.map((c) => c.state));
    expect(codes.size).toBe(52);
    for (const code of ['AL', 'AK', 'CA', 'DC', 'MI', 'PR', 'TX', 'WY']) expect(codes.has(code)).toBe(true);
  });

  it('never claims verification it does not have', () => {
    for (const c of all) {
      expect(c.verified, `${c.state} must not claim verification`).toBe(false);
      expect(c.directoryUrl).toMatch(/^https:\/\/(www\.)?nasa\.gov\//);
      expect(c.name).toMatch(/Space Grant/);
      expect(c.note.length).toBeGreaterThan(10);
    }
  });

  it('has no placeholder or private host anywhere in the file', () => {
    const blob = JSON.stringify(all);
    expect(blob).not.toMatch(/192\.168\.|10\.\d+\.|localhost/);
  });
});

/**
 * The picker's job is to ROUTE — to put an applicant in front of the right consortium's own
 * website. It is not a second corpus, and the moment it starts carrying deadlines, award sizes
 * or eligibility rules it becomes 52 unverified funder records wearing a reference file's
 * clothes. NASA runs 52 independent calendars; a deadline recorded here would belong to a
 * different consortium than the one reading it roughly 51 times out of 52.
 *
 * So the file is deliberately narrow: a state code, the consortium's name, the lead institution,
 * and one shared caveat. The assertions below are what keep it narrow.
 */
describe('the picker routes, and asserts nothing per consortium', () => {
  const FIELDS = ['state', 'name', 'leadInstitution', 'verified', 'directoryUrl', 'note'];

  it('carries exactly six fields per record and no room for a rule', () => {
    for (const c of all) {
      expect(Object.keys(c).sort(), c.state).toEqual([...FIELDS].sort());
    }
  });

  it('records no deadline, no award amount and no eligibility rule for any consortium', () => {
    const offenders: string[] = [];
    for (const c of all) {
      // Only the fields that describe THIS consortium. `note` and `directoryUrl` are shared
      // boilerplate, pinned identical below, so nothing in them can be about one consortium.
      for (const field of ['state', 'name', 'leadInstitution'] as const) {
        const value = c[field];
        if (/\$|\d/.test(value)) offenders.push(`${c.state}.${field} carries a figure: ${value}`);
        if (/\b(?:deadline|due|closes?|eligib|award|match|per year|annually)\b/i.test(value)) {
          offenders.push(`${c.state}.${field} carries a rule: ${value}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('ships one shared caveat and one shared directory link, never 52 of either', () => {
    expect(new Set(all.map((c) => c.note)).size).toBe(1);
    expect(new Set(all.map((c) => c.directoryUrl)).size).toBe(1);
    // The caveat has to say what is unverified and where to check it, or it is decoration.
    const note = all[0]?.note ?? '';
    expect(note).toMatch(/not (?:been )?(?:live-)?(?:verified|confirmed)/i);
    expect(note).toMatch(/deadline/i);
  });

  it('ships no per-consortium website, because a wrong one is worse than none', () => {
    // `consortium.url` is a `user` slot in the vocabulary: the applicant pastes the address they
    // reached from NASA's directory. Fifty-two curated URLs assembled offline would be fifty-two
    // chances to send an applicant somewhere that is no longer the consortium — the failure that
    // put a stranger's Facebook page in 345 award records, and the one that turned farweb.org
    // into a link to a gambling site.
    const blob = JSON.stringify(all);
    const urls = blob.match(/https?:\/\/[^"]+/g) ?? [];
    expect(new Set(urls).size).toBe(1);
  });

  it('hard-codes verified:false in the loader, so the data file cannot promote itself', () => {
    // The honesty property has to live in code. A file that says `verified: true` about a record
    // nobody fetched is exactly the claim this app exists to refuse, and only `verify-sources`
    // may ever make it — after a live fetch it recorded.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-consortia-'));
    fs.writeFileSync(
      path.join(dir, 'space-grant-consortia.json'),
      JSON.stringify({
        _meta: {
          description: 'doctored',
          assembledAt: '2026-08-02',
          verificationMethod: 'manual_curation',
          warning: 'doctored',
          directoryUrl: 'https://www.nasa.gov/example-directory/',
        },
        // Every state, every one of them claiming a verification nobody performed, plus a
        // smuggled per-consortium deadline field for good measure.
        consortia: all.map((c) => ({
          state: c.state.toLowerCase(),
          name: c.name,
          leadInstitution: c.leadInstitution,
          verified: true,
          lastVerifiedAt: '2026-08-02',
          deadline: 'March 1 annually',
        })),
      }),
    );
    try {
      const doctored = loadConsortia(dir);
      expect(doctored.length).toBe(52);
      expect(doctored.every((c) => c.verified === false)).toBe(true);
      expect(JSON.stringify(doctored)).not.toMatch(/March 1 annually|lastVerifiedAt/);
      // An unexpected key in the file is dropped rather than carried through, so a rule smuggled
      // into the data cannot reach a caller that never asked for one.
      expect(Object.keys(doctored[0] ?? {}).sort()).toEqual([...FIELDS].sort());
      // And a lower-case state code in the file still resolves.
      expect(pickConsortium('mi', dir)?.state).toBe('MI');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a file that has lost states rather than serving a partial map', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-consortia-'));
    fs.writeFileSync(
      path.join(dir, 'space-grant-consortia.json'),
      JSON.stringify({
        _meta: { assembledAt: '2026-08-02', warning: 'x', directoryUrl: 'https://www.nasa.gov/x/' },
        consortia: [{ state: 'MI', name: 'Michigan Space Grant Consortium', leadInstitution: 'X' }],
      }),
    );
    // A short file is a corrupted file, and a picker that silently answers `undefined` for 51
    // states looks identical to a picker whose user typed a bad code.
    try {
      expect(() => loadConsortia(dir)).toThrow(/52/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('pickConsortium', () => {
  it('resolves a two-letter state code case-insensitively', () => {
    expect(pickConsortium('mi')?.name).toMatch(/Michigan Space Grant/);
    expect(pickConsortium('MI')?.state).toBe('MI');
  });

  it('returns undefined for an unknown code rather than guessing', () => {
    expect(pickConsortium('ZZ')).toBeUndefined();
    expect(pickConsortium('')).toBeUndefined();
  });

  it('never guesses from a state name, a zip or a padded string', () => {
    // "Michigan" is not a two-letter code, and the nearest-match answer to a thing the user did
    // not type is the whole failure mode of this product.
    expect(pickConsortium('Michigan')).toBeUndefined();
    expect(pickConsortium('48109')).toBeUndefined();
    expect(pickConsortium('M')).toBeUndefined();
    // Whitespace is a typing artefact, not a different state.
    expect(pickConsortium(' mi ')?.state).toBe('MI');
  });
});

describe('the loaded reference data cannot be corrupted by a caller', () => {
  it('hands out frozen records from a cached array', () => {
    const first = loadConsortia();
    const second = loadConsortia();
    expect(second[0]).toBe(first[0]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first[0])).toBe(true);
  });
});

describe('referenceRoot', () => {
  let root: string;
  beforeAll(() => {
    root = referenceRoot();
  });
  afterAll(() => {
    // nothing to clean up; the root is the repo's own directory
  });

  it('points at the repo data/reference directory that holds the shipped file', () => {
    expect(path.basename(root)).toBe('reference');
    expect(fs.existsSync(path.join(root, 'space-grant-consortia.json'))).toBe(true);
  });
});
