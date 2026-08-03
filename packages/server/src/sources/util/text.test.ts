import { describe, expect, it } from 'vitest';
import {
  buildLabelRegExp,
  escapeRegExp,
  flattenHtml,
  looseLabelPattern,
  normalizeText,
  splitByLabels,
} from './text.js';

const LABELS = {
  'Field of Study': ['Field of Study', 'Fields of Study'],
  'License Requirement': ['License Requirement', 'License Requirements', 'License'],
  Region: ['Region', 'Regions'],
  'Award Amount': ['Award Amount', 'Amount'],
  'Number of Awards': ['Number of Awards', 'Number of Scholarships', 'Number of Scholarshps'],
  Other: ['Other'],
};

describe('normalizeText', () => {
  it('turns \\xa0 into a plain space and collapses runs', () => {
    expect(normalizeText('a  b')).toBe('a b');
  });

  it('collapses blank lines and trims each line', () => {
    expect(normalizeText('  a  \n\n\n   b  ')).toBe('a\nb');
  });
});

describe('flattenHtml', () => {
  it('puts each block element on its own line', () => {
    expect(flattenHtml('<p>one</p><p>two</p>')).toBe('one\ntwo');
    expect(flattenHtml('<ul><li>a</li><li>b</li></ul>')).toBe('a\nb');
  });

  it('survives invalid HTML with a <ul> opened inside a <p>', () => {
    const html = '<p>Intro<ul><li><strong>Region:</strong> Any</li></ul></p>';
    const flat = flattenHtml(html);
    expect(flat).toContain('Intro');
    expect(flat).toContain('Region: Any');
  });

  it('drops script, style and noscript content', () => {
    expect(flattenHtml('<p>keep</p><script>var drop=1</script><style>.drop{}</style>')).toBe(
      'keep',
    );
  });

  it('turns <br> into a line break', () => {
    expect(flattenHtml('<p>a<br>b</p>')).toBe('a\nb');
  });

  it('decodes entities and normalises &nbsp;', () => {
    expect(flattenHtml('<p>A&nbsp;&amp;&nbsp;B</p>')).toBe('A & B');
  });
});

describe('looseLabelPattern', () => {
  it('tolerates a stray space inside a word: "R egion"', () => {
    const re = new RegExp(looseLabelPattern('Region'), 'i');
    expect(re.test('Region')).toBe(true);
    expect(re.test('R egion')).toBe(true);
  });

  it('tolerates runs of whitespace between words: "License   Requirement"', () => {
    const re = new RegExp(looseLabelPattern('License Requirement'), 'i');
    expect(re.test('License   Requirement')).toBe(true);
  });
});

describe('escapeRegExp', () => {
  it('escapes regex metacharacters', () => {
    expect(new RegExp(escapeRegExp('a.b*c')).test('a.b*c')).toBe(true);
    expect(new RegExp(escapeRegExp('a.b*c')).test('axbxc')).toBe(false);
  });
});

describe('buildLabelRegExp', () => {
  it('prefers the longer alternate so "License Requirement" beats "License"', () => {
    const re = buildLabelRegExp(LABELS);
    const m = re.exec('\nLicense Requirement: General');
    expect(m).not.toBeNull();
    expect(m?.[0]).toContain('License Requirement');
  });
});

describe('splitByLabels', () => {
  it('extracts every field from a flat bullet body', () => {
    const flat = normalizeText(
      [
        'Some preamble sentence about the donor.',
        '• Field of Study: Electrical Engineering',
        '• License Requirement: General or higher',
        '• Region: ARRL Roanoke Division',
        '• Award Amount: $2,000',
        '• Number of Awards: Three',
        '• Other: Preference to a student ham from a ham family.',
      ].join('\n'),
    );
    const fields = splitByLabels(flat, LABELS);
    expect(fields['Field of Study']).toBe('Electrical Engineering');
    expect(fields['License Requirement']).toBe('General or higher');
    expect(fields.Region).toBe('ARRL Roanoke Division');
    expect(fields['Award Amount']).toBe('$2,000');
    expect(fields['Number of Awards']).toBe('Three');
    expect(fields.Other).toBe('Preference to a student ham from a ham family.');
    expect(fields.__preamble).toBe('Some preamble sentence about the donor.');
  });

  it('reads the typo’d labels observed in the wild', () => {
    const flat = normalizeText(
      ['R egion: Any', 'License   Requirement: Technician', 'Number of Scholarshps: 1'].join('\n'),
    );
    const fields = splitByLabels(flat, LABELS);
    expect(fields.Region).toBe('Any');
    expect(fields['License Requirement']).toBe('Technician');
    expect(fields['Number of Awards']).toBe('1');
  });

  it('keeps multi-line values intact', () => {
    const flat = normalizeText(
      ['Other: Applicant must submit', 'a letter from a club officer.', 'Region: Any'].join('\n'),
    );
    expect(splitByLabels(flat, LABELS).Other).toBe(
      'Applicant must submit\na letter from a club officer.',
    );
  });

  it('does not treat a mid-sentence word as a label', () => {
    const flat = 'The other requirement is a Region of any kind.';
    const fields = splitByLabels(flat, LABELS);
    expect(fields.Other).toBeUndefined();
    expect(fields.Region).toBeUndefined();
    expect(fields.__preamble).toBe(flat);
  });

  it('returns an empty object for empty input', () => {
    expect(splitByLabels('', LABELS)).toEqual({});
  });
});
