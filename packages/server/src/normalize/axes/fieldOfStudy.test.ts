// Task 17 fix round 3 — `extractFieldOfStudy` only.
//
// Every expectation below is `toEqual` on the WHOLE `fields[]` array, never `toContain`: the
// defect class this file guards against is a FABRICATED field, and a fabricated field is
// invisible to any assertion that only checks the real ones are present. A fabricated value is
// also strictly worse than a missing one — `fields[]` is a disjunction the matcher evaluates, so
// a field the funder never wrote is a filter no applicant can satisfy and the award disappears
// for exactly the students it was endowed for, with no way for them to find out. A missing field
// only widens the list; the applicant still sees the award and reads the funder's own page.
//
// Source text is quoted verbatim from
// fixtures/arrl-scholarship-descriptions/00-www-arrl-org-scholarship-descriptions.html, and each
// case was found by sweeping all 111 real entries and reading the output against the source —
// not by testing the reported entry alone. Kept in its own file rather than appended to the
// shared part1.test.ts, which several concurrently-running agents are editing for other axes.
import type { RawOpportunity } from '@grantspotter/core';
import { describe, expect, it } from 'vitest';
import { extractFieldOfStudy } from './fieldOfStudy.js';

const fieldsOf = (fieldOfStudy: string): string[] => {
  const raw: RawOpportunity = {
    sourceId: 'arrl-scholarship-descriptions',
    externalKey: 'k',
    name: 'n',
    rawFields: { 'Field of Study': fieldOfStudy },
    sourceUrl: 'https://example.test/x',
    rawText: fieldOfStudy,
  };
  const constraints = extractFieldOfStudy(raw);
  expect(constraints.length).toBe(1);
  return (constraints[0].spec as { fields: string[] }).fields;
};

describe('extractFieldOfStudy — the four entries carried over from fix round 2', () => {
  // "The Charles Clarke Cordle Memorial Scholarship". Two independent statements about two
  // different axes joined by a semicolon; round 2 left them merged, so the GPA clause's tail and
  // the preference lead-in became part of the first field name:
  // ["higher preference to students of electronics", "communications", "related fields"].
  it('splits Cordle\'s semicolon-joined GPA and field clauses instead of merging them', () => {
    expect(
      fieldsOf(
        'GPA of 2.5 or higher; preference to students of electronics, communications, or related fields',
      ),
    ).toEqual(['electronics', 'communications', 'related fields']);
  });

  // "The Central Arizona DX Association Scholarship" — the whole value is a GPA floor and names
  // no field at all. Round 2 filtered the GPA fragment but left the "or higher" tail behind as a
  // field literally named "higher", which no applicant's field of study can ever equal.
  it('returns no fields for Central Arizona DX, whose value is only a GPA floor', () => {
    expect(fieldsOf('Cumulative GPA of 3.2 or higher')).toEqual([]);
  });

  // "The Mary Lou Brown Scholarship" — a degree level plus a GPA floor, both other axes' work.
  // Round 2 produced ["Bachelor's degree", "higher"], two unmatchable values.
  it('returns no fields for Mary Lou Brown, whose value is a degree level and a GPA floor', () => {
    expect(fieldsOf("Bachelor's degree or higher; GPA 3.0 or higher")).toEqual([]);
  });

  // "The North Fulton Amateur Radio League Scholarship" — the worst case in the corpus. The
  // cascade sentence contains the source's own typo, "appilcant", and round 2 turned it into two
  // fabricated fields ("If no qualified appilcant", "award given regardless of the field of
  // study") — an award excluded on a criterion that exists only because a webmaster misspelled a
  // word. The sentence also says the opposite of a restriction: the award is open to any field if
  // no Engineering/Computer Science applicant appears.
  it('drops North Fulton\'s misspelled cascade sentence instead of mining fields from it', () => {
    expect(
      fieldsOf(
        'Engineering or Computer Science. If no qualified appilcant, award given regardless of the field of study.',
      ),
    ).toEqual(['Engineering', 'Computer Science']);
  });

  // "The Mark Kupferschmid, AC9PR, Scholarship" — the regression guard from round 2, re-asserted
  // here so it can never come back silently. A single-tier "discard everything before the last
  // list-introducer" rule wrongly discarded the first four fields, which are real here (unlike
  // MARCO/York, where the prose before the introducer is filler). Newlines are the source's own
  // line wrapping.
  it('keeps both halves of Kupferschmid\'s "X, Y, including but not limited to A, B" list', () => {
    expect(
      fieldsOf(
        'Applied sciences, technology, engineering, and\nmathematics, including but not limited to astronomy, communications,\ncomputers, electronics, and physics.',
      ),
    ).toEqual([
      'Applied sciences',
      'technology',
      'engineering',
      'mathematics',
      'astronomy',
      'communications',
      'computers',
      'electronics',
      'physics',
    ]);
  });
});

describe('extractFieldOfStudy — "no restriction" said in words other than "Any"', () => {
  // Five real entries state that there is no field restriction, and only one of them says "Any".
  // Every other spelling used to become a literal field name — "No preference", "No
  // requirements", "All", "None" — which hid four wide-open awards from every applicant.
  it.each([
    ['No preference.', 'The 10-10 International Scholarships'],
    ['No requirements.', 'The Richard G. Kirkpatrick, K8WU, Memorial Scholarship'],
    ['All', 'The North Texas Section Bob Nelson, KB5BNU, Memorial Scholarship'],
    ['None', 'The K6GO Gayle Olson and NA6MB Mike Binder Scholarship / QCWA'],
    ['Any', 'The ARRL General Fund Scholarship (unchanged, guards the original behaviour)'],
  ])('reads %j as unconstrained (%s)', (text) => {
    expect(fieldsOf(text)).toEqual([]);
  });

  // "The New England Amateur Radio Festival (NEAR-Fest) Memorial Scholarship". This one is the
  // regression this round's own sweep caught: the funder accepts ANY undergraduate degree, and
  // the new degree-level stripper — applied before the "Any" check — briefly turned the award
  // into a hard ["radio communications"] filter. The unconstrained test now runs on the raw
  // clause, before any stripper.
  it('keeps an "Any ... degree or ... school in <field>" value unconstrained (NEAR-Fest)', () => {
    expect(
      fieldsOf('Any undergraduate degree or a two-year technical school in radio communications'),
    ).toEqual([]);
  });

  it('still records the corpus\'s one real exclusion (Rick Hughes)', () => {
    const raw: RawOpportunity = {
      sourceId: 'arrl-scholarship-descriptions',
      externalKey: 'k',
      name: 'n',
      rawFields: { 'Field of Study': 'Any, except for Liberal Arts' },
      sourceUrl: 'https://example.test/x',
      rawText: 'Any, except for Liberal Arts',
    };
    expect(extractFieldOfStudy(raw)[0].spec).toMatchObject({
      fields: [],
      excludedFields: ['Liberal Arts'],
    });
  });
});

describe('extractFieldOfStudy — degree level is the institution axis\'s work, not a field', () => {
  // "Bachelor's degree or higher in <list>" is the single most common shape in this corpus (eight
  // entries). It used to yield a fabricated "Bachelor's degree" field plus a mangled first real
  // field ("higher in electronics").
  it('strips the degree preamble from the eight-entry "degree or higher in X" shape (Irving W. Cook)', () => {
    expect(
      fieldsOf("Bachelor's degree or higher in electronics, communications, or related fields"),
    ).toEqual(['electronics', 'communications', 'related fields']);
  });

  it('strips "Associate\'s or higher degree in the fields of ..." (Joel R. Miller STEM)', () => {
    expect(
      fieldsOf(
        "Associate's or higher degree in the fields of Science, Technology, Engineering, or Mathematics.",
      ),
    ).toEqual(['Science', 'Technology', 'Engineering', 'Mathematics']);
  });

  it('strips "Studies toward a ... degree in any field of ..." (Gary Wagner, K3OMI)', () => {
    expect(fieldsOf('Studies toward a Bachelor of Science degree in any field of engineering')).toEqual(
      ['engineering'],
    );
  });

  // "The CARA Merit Scholarship" and "The Yankee Clipper Contest Club Youth Scholarship" describe
  // an institution type and a program length. Neither names a field, and both used to produce a
  // full array of unmatchable values ("An accredited 2-", "4-year college", "university", "trade
  // school" / "2", "4-year program").
  it('returns no fields when the value only describes the institution or program (CARA, Yankee Clipper)', () => {
    expect(fieldsOf('An accredited 2- or 4-year college, university or trade school')).toEqual([]);
    expect(fieldsOf('2 or 4-year program')).toEqual([]);
  });

  // "The David Knaus Memorial Scholarship" — a degree level with the club's sponsorship note
  // pasted onto it by the source, which used to become a "field of study" containing an embedded
  // newline and the sponsor's name.
  it('drops a sponsorship note pasted into the value (David Knaus)', () => {
    expect(
      fieldsOf(
        "Bachelor's degree or a 2 year Associate's degree\nThis Scholarship is sponsored by the West Allis Radio Amateur Club",
      ),
    ).toEqual([]);
  });

  // One substantive word is enough to keep a fragment: these two must NOT be swept up by the
  // degree/institution filtering above. "The Fritz Nitsch, W4NTO, Memorial Scholarship" and
  // "IRARC Memorial, Joseph P. Rubino, WA4MMD, Scholarship".
  it('keeps a degree phrase that also names a subject (Fritz Nitsch, IRARC)', () => {
    expect(fieldsOf('Engineering or other 4-year technical degree')).toEqual([
      'Engineering',
      'other 4-year technical degree',
    ]);
    expect(fieldsOf('Undergraduate degree or electronic technician certification program')).toEqual([
      'electronic technician certification program',
    ]);
  });
});

describe('extractFieldOfStudy — parentheses are separators, not part of a name', () => {
  // Three real entries pair an acronym with its expansion. Both are real; the parenthesis used to
  // be glued into the field name, producing "STEM (science" and "manufacturing)".
  it('splits ECARS\'s "STEM (science, technical, engineering, manufacturing)"', () => {
    expect(fieldsOf('STEM (science, technical, engineering, manufacturing)')).toEqual([
      'STEM',
      'science',
      'technical',
      'engineering',
      'manufacturing',
    ]);
  });

  it('splits SEMARC\'s trailing "(STEM)" acronym', () => {
    expect(fieldsOf('Applied sciences, technology, engineering, or mathematics (STEM)')).toEqual([
      'Applied sciences',
      'technology',
      'engineering',
      'mathematics',
      'STEM',
    ]);
  });
});

describe('extractFieldOfStudy — preference handling is unchanged by this round', () => {
  // "The Robert A. Rodriguez K5AUW Scholarship" — round 1's preamble fix, re-asserted because
  // this round rewrote the PREAMBLE regex to also reach Cordle's "preference to students of ...".
  it('still strips the leading preference preamble (Rodriguez)', () => {
    expect(
      fieldsOf(
        'Preference will be given to applicants pursuing studies in Electrical Engineering, Electronics Engineering, Computer Engineering, Electrical Technology, Electronics Technology, or Computer Technology',
      ),
    ).toEqual([
      'Electrical Engineering',
      'Electronics Engineering',
      'Computer Engineering',
      'Electrical Technology',
      'Electronics Technology',
      'Computer Technology',
    ]);
  });

  // "The Michael Holt, K8MJH, and Mary Holt, KC8OIP, Scholarship" — a single field, where the
  // trailing generic descriptor ("discipline") is still stripped. The same words at the end of a
  // LIST are a real entry the funder wrote (Cordle's "related fields"), which is why the
  // descriptor strip now only applies when nothing list-shaped is left.
  it('still strips a trailing descriptor from a single field (Michael Holt)', () => {
    expect(fieldsOf('Preference for an Engineering discipline')).toEqual(['Engineering']);
  });

  // "The Medical Amateur Radio Council (MARCO) Scholarship" — round 2's postamble fix. The
  // degree-level preference sentence must still be dropped whole, not mined for fields.
  it('still drops the degree-level preference postamble sentence (MARCO)', () => {
    expect(
      fieldsOf(
        'Field of study must be leading to a career in the healing arts, including, but not necessarily leading to Medicine, Dentistry, Veterinary Medicine, Nursing, Pharmacy, EMT, or Radiology technician. Preference will be given to undergraduate students and those in certificate programs, but graduate students may apply.',
      ),
    ).toEqual([
      'Medicine',
      'Dentistry',
      'Veterinary Medicine',
      'Nursing',
      'Pharmacy',
      'EMT',
      'Radiology technician',
    ]);
  });

  it('drops the leading article from a field name (Richard Warren K6OBS)', () => {
    expect(
      fieldsOf('Education, Science, Math, Engineering, Technology or a Health Care-related field.'),
    ).toEqual([
      'Education',
      'Science',
      'Math',
      'Engineering',
      'Technology',
      'Health Care-related field',
    ]);
  });
});

/**
 * Round 4 — A GPA FLOOR FILED UNDER `Field of Study`, AND THE PREFERENCE BESIDE IT.
 *
 * Charles Clarke Cordle's `Field of Study` value is two statements about two different axes:
 *
 *   "GPA of 2.5 or higher; preference to students of electronics, communications, or related fields"
 *
 * The half the funder REQUIRES is a GPA floor, which names no field of study at all and is
 * `gpa.ts`'s business — that axis already publishes `min: 2.5` for this entry, read from the same
 * text through its `rawText` fallback. The half that names fields is explicitly a PREFERENCE.
 *
 * So this axis DECLINES the requirement half rather than inventing something out of it. Two ways
 * of "using" it were both rejected: minting a `fields[]` entry from GPA wording is a filter no
 * applicant can satisfy (the fabrication defect this whole file guards), and synthesising a GPA
 * constraint here would duplicate `gpa.ts` from an axis that has no business owning a GPA floor —
 * two extractors publishing the same requirement is how they drift. Declining is the honest
 * answer, and it leaves exactly one constraint: the preference, soft, carrying the funder's own
 * wording.
 *
 * That softness is now a property of the constraint's own text ("preference to students of…"),
 * not of `makeConstraint`'s preference-derived-spec guard.
 */
describe('round 4 — a requirement and a preference in one Field of Study value', () => {
  const constraintsOf = (fieldOfStudy: string) => {
    const raw: RawOpportunity = {
      sourceId: 'arrl-scholarship-descriptions',
      externalKey: 'k',
      name: 'n',
      rawFields: { 'Field of Study': fieldOfStudy },
      sourceUrl: 'https://example.test/x',
      rawText: fieldOfStudy,
    };
    return extractFieldOfStudy(raw);
  };

  const CORDLE =
    'GPA of 2.5 or higher; preference to students of electronics, communications, or related fields';

  it('Cordle — one SOFT constraint holding the preferred fields, scoped to the preference clause', () => {
    const cs = constraintsOf(CORDLE);
    expect(cs).toHaveLength(1);
    expect(cs[0].hard).toBe(false);
    expect(cs[0].fallbackRank).toBe(0);
    expect(cs[0].rawText).toBe(
      'preference to students of electronics, communications, or related fields',
    );
    expect(cs[0].spec).toEqual({
      axis: 'field_of_study',
      fields: ['electronics', 'communications', 'related fields'],
      excludedFields: [],
    });
  });

  it('Cordle — the GPA half is declined outright: no field, no exclusion, no hard constraint', () => {
    // Stated as a property so it survives any future reshaping of the output: nothing this axis
    // emits for Cordle may bar anyone, and no fragment of the GPA sentence may become a field.
    for (const c of constraintsOf(CORDLE)) {
      expect(c.hard).toBe(false);
      const spec = c.spec as { fields: string[]; excludedFields: string[] };
      for (const value of [...spec.fields, ...spec.excludedFields]) {
        expect(value).not.toMatch(/gpa|2\.5|higher/i);
      }
    }
  });

  it('MARCO is unchanged: a preference sentence naming no field adds no second constraint', () => {
    // The regression this round's own sweep caught. Run on its own, MARCO's degree-level
    // preference sentence hits the "every sentence dropped" safety net and mines three fabricated
    // fields out of its commas ("Preference will be given to undergraduate students", …). The
    // preference half is therefore extracted WITHOUT that safety net, so it yields nothing, and
    // with nothing to separate the value is left exactly as it was: one hard constraint whose
    // rawText is the whole funder value.
    const value =
      'Field of study must be leading to a career in the healing arts, including, but not ' +
      'necessarily leading to Medicine, Dentistry, Veterinary Medicine, Nursing, Pharmacy, EMT, ' +
      'or Radiology technician. Preference will be given to undergraduate students and those in ' +
      'certificate programs, but graduate students may apply.';
    const cs = constraintsOf(value);
    expect(cs).toHaveLength(1);
    expect(cs[0].hard).toBe(true);
    expect(cs[0].rawText).toBe(value);
    expect(cs[0].spec).toEqual({
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

  it('Holt is unchanged: a value that is nothing but a preference stays one soft constraint', () => {
    // There is no requirement half to scope to, so there is nothing to split. Pinned here as well
    // as in licenseFloorContract.test.ts because that audit asserts this exact rawText.
    const cs = constraintsOf('Preference for an Engineering discipline');
    expect(cs).toHaveLength(1);
    expect(cs[0].hard).toBe(false);
    expect(cs[0].rawText).toBe('Preference for an Engineering discipline');
    expect(cs[0].spec).toEqual({
      axis: 'field_of_study',
      fields: ['Engineering'],
      excludedFields: [],
    });
  });

  it('the corpus\'s one real exclusion is unchanged and still HARD (Rick Hughes)', () => {
    // An exclusion is a requirement, and it must never be handed to a soft, preference-scoped
    // constraint. This value carries no preference at all, so it takes the untouched path.
    const cs = constraintsOf('Any, except for Liberal Arts');
    expect(cs).toHaveLength(1);
    expect(cs[0].hard).toBe(true);
    expect(cs[0].spec).toEqual({
      axis: 'field_of_study',
      fields: [],
      excludedFields: ['Liberal Arts'],
    });
  });
});
