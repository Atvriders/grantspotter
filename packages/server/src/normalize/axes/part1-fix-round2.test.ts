// Task 17 fix round 2 regression tests, against real fixture text swept from the full
// arrl-scholarship-descriptions corpus (see task-17-report.md). Kept in a dedicated file rather
// than appended to part1.test.ts: several other concurrently-running agents are actively adding
// their own tests to part1.test.ts for other axes (license, institution, ...), and this task is
// scoped to touching only gpa.ts, fieldOfStudy.ts, and "their tests" — a new file scoped to
// exactly those two extractors avoids any risk of this commit picking up another agent's
// in-flight, unrelated edits to the shared part1.test.ts.
import type { RawOpportunity } from '@grantspotter/core';
import { describe, expect, it } from 'vitest';
import { extractFieldOfStudy } from './fieldOfStudy.js';
import { extractGpa } from './gpa.js';

const raw = (fields: Record<string, string>, rawText = ''): RawOpportunity => ({
  sourceId: 's',
  externalKey: 'k',
  name: 'n',
  rawFields: fields,
  sourceUrl: 'https://example.test/x',
  rawText: rawText || Object.values(fields).join('\n'),
});

describe('extractGpa — the "grade point average" synonym (real corpus, sweep finding #1)', () => {
  // fixtures/arrl-scholarship-descriptions, "The Wayne Nelson, KB4UT, Memorial Scholarship".
  // Spelled out in full rather than "GPA" — before this fix, extraction returned [] and the
  // constraint silently vanished, showing the scholarship to students below its 3.0 floor.
  it('reads a hard floor spelled "grade point average" (Wayne Nelson)', () => {
    const c = extractGpa(
      raw({
        Other:
          'Applicant must be a US citizen; applicant must have a demonstrated previous grade point average of 3.0 or higher on a 4.0 scale in high school or in the previous undergraduate year',
      }),
    );
    expect(c.length).toBe(1);
    expect(c[0].hard).toBe(true);
    expect(c[0].spec).toMatchObject({ axis: 'gpa', min: 3 });
  });

  // Same corpus, "The South East Metro Amateur Radio Club (SEMARC) Scholarship" — a second real
  // "grade point average" line, confirming the fix isn't overfit to one entry's phrasing.
  it('reads a hard floor spelled "grade point average requirement" (SEMARC)', () => {
    const c = extractGpa(
      raw({
        Other:
          'Must be a high school senior at time of application and have a grade point average requirement of 3.0 or higher out of a maximum of 4.0',
      }),
    );
    expect(c.length).toBe(1);
    expect(c[0].hard).toBe(true);
    expect(c[0].spec).toMatchObject({ axis: 'gpa', min: 3 });
  });
});

describe('extractGpa — unbounded rawText fallback no longer flips hard (sweep finding #2)', () => {
  // fixtures/arrl-scholarship-descriptions, "The Charles Clarke Cordle Memorial Scholarship".
  // This entry has NO `Other` field — its GPA text is filed (by the source) under `Field of
  // Study`, so extraction can only reach it through the `rawText` fallback. Before this fix, the
  // fallback searched the ENTIRE flattened record with no boundary, and an unrelated
  // FIELD-OF-STUDY preference elsewhere in that blob ("preference to students of electronics,
  // communications, or related fields") flipped the GPA constraint soft even though the funder
  // states it as a hard floor ("GPA of 2.5 or higher").
  it('keeps the GPA floor hard when it has no Other field and no sentence terminator (Cordle)', () => {
    const raw2: RawOpportunity = {
      sourceId: 'arrl-scholarship-descriptions',
      externalKey: 'The Charles Clarke Cordle Memorial Scholarship',
      name: 'The Charles Clarke Cordle Memorial Scholarship',
      rawFields: {
        'Award Amount': '$1,000',
        'Number of Awards': '1 per year',
        'License Requirement': 'Any active Amateur Radio License Class',
        Region: 'Resident of GA or AL',
        'Field of Study':
          'GPA of 2.5 or higher; preference to students of electronics, communications, or related fields',
        Institution: 'Any in GA or AL',
      },
      sourceUrl: 'https://example.test/x',
      rawText:
        'Award Amount: $1,000\nNumber of Awards: 1 per year\nLicense Requirement: Any active Amateur Radio License Class\nRegion: Resident of GA or AL\nField of Study:\nGPA of 2.5 or higher; preference to students of electronics, communications, or related fields\nInstitution: Any in GA or AL',
    };
    const c = extractGpa(raw2);
    expect(c.length).toBe(1);
    expect(c[0].hard).toBe(true);
    expect(c[0].spec).toMatchObject({ axis: 'gpa', min: 2.5 });
    // The extracted clause must not have swallowed the unrelated Region/Institution/etc. fields.
    expect(c[0].rawText).not.toMatch(/Institution|License Requirement|Award Amount/);
  });

  // Same shape, but the semicolon-joined clause genuinely IS about GPA (repeats the word), which
  // must still merge and come out soft — this is fix round 1's IRARC case, re-asserted here as a
  // sibling to Cordle so the two opposite outcomes are pinned down side by side.
  it('still merges a semicolon-joined clause that continues talking about GPA (IRARC, unchanged)', () => {
    const c = extractGpa(
      raw({ Other: 'Minimum 2.5 GPA on a 4.0 scale; preference given to need and higher GPA' }),
    );
    expect(c[0].hard).toBe(false);
    expect(c[0].spec).toMatchObject({ axis: 'gpa', min: 2.5 });
  });
});

describe('extractFieldOfStudy — postamble leak is fully clean, not just improved (sweep finding #3)', () => {
  // fixtures/arrl-scholarship-descriptions, "The Medical Amateur Radio Council (MARCO)
  // Scholarship" (the line previously logged as "one trailing leak" in the round-1 report). The
  // reviewer found the whole array was garbage: 11 junk entries, not one trailing leak. Real
  // text: "Field of study must be leading to a career in the healing arts, including, but not
  // necessarily leading to Medicine, Dentistry, Veterinary Medicine, Nursing, Pharmacy, EMT, or
  // Radiology technician. Preference will be given to undergraduate students and those in
  // certificate programs, but graduate students may apply."
  it('extracts exactly the 7 real fields and drops the whole degree-level postamble sentence (MARCO)', () => {
    const c = extractFieldOfStudy(
      raw({
        'Field of Study':
          'Field of study must be leading to a career in the healing arts, including, but not necessarily leading to Medicine, Dentistry, Veterinary Medicine, Nursing, Pharmacy, EMT, or Radiology technician. Preference will be given to undergraduate students and those in certificate programs, but graduate students may apply.',
      }),
    );
    expect(c.length).toBe(1);
    expect(c[0].spec).toMatchObject({
      axis: 'field_of_study',
      fields: [
        'Medicine',
        'Dentistry',
        'Veterinary Medicine',
        'Nursing',
        'Pharmacy',
        'EMT',
        'Radiology technician',
      ],
      excludedFields: [],
    });
  });

  // Same corpus, "The John C. York, KE5V, Scholarship" — the same "leading to a career in the
  // healing arts, including ..." shape, found while sweeping, with a different lead-in
  // ("pursuing a field of study leading to a career in..."). No preference language at all here,
  // so hard stays true throughout — this asserts the fix doesn't accidentally change that.
  it('extracts exactly the 6 real fields from the second "healing arts" shape (York)', () => {
    const c = extractFieldOfStudy(
      raw({
        'Field of Study':
          'Applicant must be pursuing a field of study leading to a career in the healing arts, including but not limited to a career in Medicine, Nursing, Dentistry, Pharmacy, EMT, or Radiology',
      }),
    );
    expect(c.length).toBe(1);
    expect(c[0].hard).toBe(true);
    expect(c[0].spec).toMatchObject({
      axis: 'field_of_study',
      fields: ['Medicine', 'Nursing', 'Dentistry', 'Pharmacy', 'EMT', 'Radiology'],
      excludedFields: [],
    });
  });

  // fixtures/arrl-scholarship-descriptions, "The Mark Kupferschmid, AC9PR, Scholarship" — found
  // while sweeping for the MARCO/York fix's blast radius: an "including but not limited to" list
  // where BOTH halves are real fields ("Applied sciences, technology, engineering, and
  // mathematics, including but not limited to astronomy, communications, computers, electronics,
  // and physics."). This is the regression guard for the MARCO/York fix: a naive "discard
  // everything before the last list-introducer" rule would wrongly drop the first four fields
  // here, where they are genuine, not filler prose.
  it('keeps both halves of an "X, Y, including but not limited to A, B" list (Kupferschmid)', () => {
    const c = extractFieldOfStudy(
      raw({
        'Field of Study':
          'Applied sciences, technology, engineering, and\nmathematics, including but not limited to astronomy, communications,\ncomputers, electronics, and physics.',
      }),
    );
    expect(c.length).toBe(1);
    expect(c[0].spec).toMatchObject({
      axis: 'field_of_study',
      fields: [
        'Applied sciences',
        'technology',
        'engineering',
        'mathematics',
        'astronomy',
        'communications',
        'computers',
        'electronics',
        'physics',
      ],
    });
  });
});
