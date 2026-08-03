import { describe, expect, it } from 'vitest';
import { ADJACENCY_THRESHOLD, ADJACENCY_VOCABULARY, isAdjacent, scoreAdjacency } from './adjacency.js';

describe('the vocabulary itself', () => {
  it('pins the threshold at 6', () => {
    expect(ADJACENCY_THRESHOLD).toBe(6);
  });

  it('has no duplicate terms and every weight is a non-zero integer', () => {
    const terms = ADJACENCY_VOCABULARY.map((t) => t.term.toLowerCase());
    expect(new Set(terms).size).toBe(terms.length);
    for (const t of ADJACENCY_VOCABULARY) {
      expect(Number.isInteger(t.weight)).toBe(true);
      expect(t.weight).not.toBe(0);
    }
  });

  it('carries the four named adjacent programs the research identified', () => {
    const joined = ADJACENCY_VOCABULARY.map((t) => t.term).join('|');
    for (const term of ['geospace', 'Advanced Technological Education', 'Noyce', 'MUREP', 'Space Grant', 'PWSCIF']) {
      expect(joined).toContain(term);
    }
  });

  it('carries negative weights for the radiology family', () => {
    const negatives = ADJACENCY_VOCABULARY.filter((t) => t.weight < 0).map((t) => t.term);
    expect(negatives).toEqual(expect.arrayContaining(['radiation oncology', 'radiology', 'radiotherapy']));
  });
});

describe('scoreAdjacency', () => {
  it('scores a direct ham signal plus context above the threshold', () => {
    const r = scoreAdjacency('Amateur radio ionospheric sounding with a distributed STEM education component.');
    expect(r.score).toBeGreaterThanOrEqual(ADJACENCY_THRESHOLD);
    expect(r.hits).toEqual(expect.arrayContaining(['amateur radio', 'ionospheric', 'STEM education']));
  });

  it('scores the real NSF geospace case as adjacent', () => {
    expect(
      isAdjacent(
        'Geospace Facilities supports incoherent scatter radar and space weather instrumentation engaging undergraduate research.',
      ),
    ).toBe(true);
  });

  it('scores the real ATE community-college case as adjacent', () => {
    expect(
      isAdjacent(
        'Advanced Technological Education supports technician education at community college programs in wireless innovation.',
      ),
    ).toBe(true);
  });

  it('scores NASA Space Grant plus MUREP as adjacent', () => {
    expect(isAdjacent('The Space Grant consortium partners with MUREP on student projects.')).toBe(true);
  });

  it('does NOT clear the threshold on generic STEM language alone', () => {
    const r = scoreAdjacency('This program supports STEM education and workforce development.');
    expect(r.score).toBeLessThan(ADJACENCY_THRESHOLD);
    expect(isAdjacent('This program supports STEM education and workforce development.')).toBe(false);
  });

  it('does NOT fire on a single generic term', () => {
    expect(isAdjacent('An outreach program.')).toBe(false);
    expect(isAdjacent('Antenna design coursework.')).toBe(false);
  });

  it('rejects the radiology family that a naive "radio" match would catch', () => {
    const r = scoreAdjacency(
      'Radiation Oncology Outcomes Research: radiotherapy dosimetry and radiopharmaceutical STEM education training.',
    );
    expect(r.score).toBe(0);
    expect(isAdjacent(r.hits.join(' '))).toBe(false);
  });

  it('rejects public broadcasting', () => {
    expect(isAdjacent('Grants for public broadcasting and broadcast television station upgrades.')).toBe(false);
  });

  it('counts a repeated term only once, so a verbose abstract cannot inflate itself', () => {
    const once = scoreAdjacency('amateur radio');
    const tenTimes = scoreAdjacency(Array(10).fill('amateur radio').join(' '));
    expect(tenTimes.score).toBe(once.score);
    expect(tenTimes.hits).toEqual(['amateur radio']);
  });

  it('is case-insensitive', () => {
    expect(scoreAdjacency('AMATEUR RADIO').score).toBe(scoreAdjacency('amateur radio').score);
  });

  it('respects word boundaries: SDR does not match SDRAM, ATE does not match CANDIDATE', () => {
    expect(scoreAdjacency('SDRAM memory modules').hits).not.toContain('SDR');
    expect(scoreAdjacency('the successful CANDIDATE will').hits).not.toContain('ATE');
    expect(scoreAdjacency('an SDR receiver').hits).toContain('SDR');
  });

  it('clamps to a floor of zero rather than going negative', () => {
    expect(scoreAdjacency('radiology radiotherapy radioactive radiocarbon').score).toBe(0);
  });

  it('returns zero and no hits for empty input', () => {
    expect(scoreAdjacency('')).toEqual({ score: 0, hits: [] });
  });

  it('returns hits in descending weight order so the UI can explain itself', () => {
    const r = scoreAdjacency('STEM education using amateur radio and geospace data.');
    expect(r.hits[0]).toBe('amateur radio');
    expect(r.hits[r.hits.length - 1]).toBe('STEM education');
  });
});
