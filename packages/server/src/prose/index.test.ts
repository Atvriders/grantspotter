import { describe, expect, it } from 'vitest';
// The real thing, from Task 3. `prose/index.ts` cannot import it — the purity walk in
// features.test.ts fails any specifier that does not start with `./`, and this one reaches
// `@grantspotter/core` transitively — so it duplicates the scan regex and this file pins the two
// together. Test files are excluded from that walk, so importing it HERE is legal and is the
// only place the duplication can be checked.
import { stripTodoMarkers } from '../templates/fill.js';
import { analyzeProse, paragraphDensities } from './index.js';

/** Style words everywhere, no proper noun, no figure, no date. */
const GENERIC = [
  "In today's rapidly evolving landscape, our organization delves into the transformative",
  'potential of amateur radio to empower the next generation. Furthermore, this comprehensive',
  'initiative underscores our unwavering commitment to educate, empower, and inspire learners',
  'across a myriad of disciplines, ensuring that participants gain invaluable insights. Moreover,',
  'the implementation of a robust outreach framework will foster meaningful engagement, allowing',
  'us to leverage cutting-edge methodologies while enhancing community resilience, thereby',
  'ensuring long-term impact for years to come.',
].join(' ');

/** Names, callsigns, rooms, model numbers, counts and dates. */
const SPECIFIC = [
  'Three of our members — Dana Ruiz KD9XYZ, Marcus Hall W9ABC, and Priya Nair KE8QRS — will teach',
  'a four-session licensing class in Room 214 of the Engineering Building on the Saturdays of',
  'March 7, 14, 21, and 28, 2027. Dana Ruiz has taught the same syllabus twice for the Ann Arbor',
  'Amateur Radio Club and holds a General class license. The class seats 24 students; the Fall',
  '2026 session filled all 24 seats and 19 of those students passed the Technician exam. We will',
  'buy one Icom IC-7300 transceiver and two Comet GP-3 antennas so the class can run on-air',
  'demonstrations from the roof of the Engineering Building.',
].join(' ');

/** True, readable, and almost entirely unreferenced — the common real-world case. */
const THIN = [
  'Our club, K5UTD, has struggled to keep its station usable since the spring of 2024. Members',
  'who want to operate often find that the antenna is disconnected or that a cable has failed,',
  'and they leave without making a contact. We believe a working station would change how',
  'students see the hobby, and we think more of them would stay involved after their first',
  'semester. The request in this application would let us repair what we have rather than',
  'replace it, which is the cheaper path and the one our officers prefer.',
].join(' ');

describe('analyzeProse — known-generic passage', () => {
  const report = analyzeProse(GENERIC);
  const p = report.paragraphs[0]!;

  it('finds no proper noun and no figure at all', () => {
    expect(p.properNounCount).toBe(0);
    expect(p.figureCount).toBe(0);
    expect(report.paragraphsWithNoProperNounOrFigure).toEqual([0]);
  });

  it('calls it generic', () => {
    expect(p.verdict).toBe('generic');
  });

  it('locates the banned transitions', () => {
    expect(p.stockTransitionHits).toContain('Furthermore');
    expect(p.stockTransitionHits).toContain('Moreover');
  });

  it('locates the stock opener and the stock closer', () => {
    expect(report.stockOpenerHits.some((h) => /rapidly evolving landscape/i.test(h))).toBe(true);
    expect(report.stockCloserHits.some((h) => /for years to come/i.test(h))).toBe(true);
  });

  it('counts the tricolon and the trailing participials', () => {
    expect(p.tricolonCount).toBeGreaterThanOrEqual(1);
    expect(report.documentTricolonCount).toBeGreaterThanOrEqual(1);
    expect(p.trailingParticipialCount).toBeGreaterThanOrEqual(3);
  });

  it('reports a high style-word density with no referential counterweight', () => {
    const d = paragraphDensities(p);
    expect(p.styleWordHits.length).toBeGreaterThanOrEqual(8);
    expect(d.referentDensity).toBe(0);
    expect(d.styleDensity).toBeGreaterThan(4);
  });
});

describe('analyzeProse — known-specific passage', () => {
  const report = analyzeProse(SPECIFIC);
  const p = report.paragraphs[0]!;

  it('calls it specific', () => {
    expect(p.verdict).toBe('specific');
  });

  it('finds many proper nouns and many figures', () => {
    expect(p.properNounCount).toBeGreaterThanOrEqual(20);
    expect(p.figureCount).toBeGreaterThanOrEqual(10);
    expect(report.paragraphsWithNoProperNounOrFigure).toEqual([]);
  });

  it('finds no banned transition, no stock opener and no stock closer', () => {
    expect(p.stockTransitionHits).toEqual([]);
    expect(report.stockOpenerHits).toEqual([]);
    expect(report.stockCloserHits).toEqual([]);
  });

  it('does not mistake a list of dates or names for a tricolon', () => {
    expect(p.tricolonCount).toBe(0);
  });

  it('reports referential density well above style density', () => {
    const d = paragraphDensities(p);
    expect(d.referentDensity).toBeGreaterThan(20);
    expect(d.styleDensity).toBeLessThan(d.referentDensity);
  });
});

describe('analyzeProse — known-thin passage', () => {
  const report = analyzeProse(THIN);
  const p = report.paragraphs[0]!;

  it('calls it thin: true and readable, but barely referenced', () => {
    expect(p.verdict).toBe('thin');
  });

  it('finds at least one proper noun and one figure, but few', () => {
    expect(p.properNounCount).toBeGreaterThanOrEqual(1);
    expect(p.figureCount).toBeGreaterThanOrEqual(1);
    expect(p.styleWordHits.length).toBeLessThanOrEqual(3);
  });
});

describe('analyzeProse — document level', () => {
  it('indexes paragraphs and reports sentence-length variance across the document', () => {
    const report = analyzeProse(`${SPECIFIC}\n\n${THIN}\n\n${GENERIC}`);
    expect(report.paragraphs.map((p) => p.index)).toEqual([0, 1, 2]);
    expect(report.paragraphs[0]?.verdict).toBe('specific');
    expect(report.paragraphs[2]?.verdict).toBe('generic');
    expect(report.paragraphsWithNoProperNounOrFigure).toEqual([2]);
    expect(report.sentenceLengthVariance).toBeGreaterThan(0);
  });

  it('handles empty input without throwing', () => {
    const report = analyzeProse('   \n\n  ');
    expect(report.paragraphs).toEqual([]);
    expect(report.sentenceLengthVariance).toBe(0);
    expect(report.documentTricolonCount).toBe(0);
  });

  it('is pure: the same input yields a deeply equal report every time', () => {
    expect(analyzeProse(THIN)).toEqual(analyzeProse(THIN));
  });
});

/**
 * Task 12's problem 1. Three lexicon entries sit in two report fields at once
 * (`Notably` / `Importantly` / `Ultimately` are WATCH_TRANSITIONS *and* STYLE_WORDS;
 * `In conclusion` is a WATCH_TRANSITION *and* a STOCK_CLOSER). Reporting a phrase twice
 * overstates both counts, and styleWordHits.length is a density numerator, so a double
 * report is not cosmetic — it moves the verdict.
 */
describe('analyzeProse — a phrase is reported exactly once', () => {
  it('does not also count a reported transition as a style word', () => {
    const report = analyzeProse(
      'Notably, the club will foster meaningful engagement across the region and hold a class.',
    );
    const p = report.paragraphs[0]!;
    expect(p.stockTransitionHits).toEqual(['Notably']);
    expect(p.styleWordHits).not.toContain('Notably');
    expect(p.styleWordHits).toEqual(['foster', 'meaningful', 'engagement']);
    expect(p.verdict).toBe('generic');
  });

  it('does not also count the words inside a reported stock closer as style words', () => {
    const p = analyzeProse(GENERIC).paragraphs[0]!;
    // "ensuring long-term impact for years to come" carries `ensure` and `impact`; the
    // paragraph's OTHER "ensuring" (", ensuring that participants gain…") is a separate
    // occurrence and must survive.
    expect(p.styleWordHits.filter((h) => h.toLowerCase() === 'ensuring')).toEqual(['ensuring']);
    expect(p.styleWordHits).not.toContain('impact');
    // …and the stock opener's own "landscape" is likewise reported once, as the opener.
    expect(p.styleWordHits).not.toContain('landscape');
  });

  it('reports "In conclusion" as a stock closer, not also as a transition, when it closes', () => {
    const report = analyzeProse('In conclusion, we look forward to partnering with you.');
    expect(report.paragraphs[0]!.stockTransitionHits).toEqual([]);
    expect(report.stockCloserHits).toEqual([
      'In conclusion',
      'we look forward to partnering with you',
    ]);
  });

  it('reports "In conclusion" as a transition when it opens a paragraph instead', () => {
    const report = analyzeProse(
      'In conclusion, the club will repair the antenna at K5UTD, replace 40 feet of coaxial ' +
        'cable, and run a licensing class in Room 214 on March 7, 2027, so that the station is ' +
        'usable before the fall semester starts.',
    );
    expect(report.paragraphs[0]!.stockTransitionHits).toEqual(['In conclusion']);
    expect(report.stockCloserHits).toEqual([]);
  });
});

/**
 * Task 12's problem 2. `for years to come` is a proper substring of
 * `ensuring long-term impact for years to come`; matching shortest-first reports the wrong
 * span and counts one phrase as two.
 */
describe('analyzeProse — overlapping stock phrases match longest-first', () => {
  it('reports the long closer once and never its own suffix as a second hit', () => {
    const report = analyzeProse(GENERIC);
    expect(report.stockCloserHits).toEqual(['ensuring long-term impact for years to come']);
  });

  it('does not match a stock phrase that is only the prefix of a longer word', () => {
    const report = analyzeProse(
      'The board approved an increase in additional funding for the repeater at W8UM this spring.',
    );
    expect(report.paragraphs[0]!.stockTransitionHits).toEqual([]);
  });
});

/**
 * Task 12's problem 3. A title-case heading standing alone as a paragraph scores one proper
 * noun and slips past the zero-referent check; with no proper noun at all it scores a
 * referentDensity of 0 and gets accused of being generic. Densities over a handful of
 * words are noise in both directions, so a paragraph below the minimum is measured but not judged.
 */
describe('analyzeProse — a paragraph too short to judge is measured, not judged', () => {
  const report = analyzeProse(`Statement of Need\n\nOur approach\n\n${THIN}`);

  it('does not call a bare title-case heading specific', () => {
    const heading = report.paragraphs[0]!;
    expect(heading.text).toBe('Statement of Need');
    expect(heading.properNounCount).toBe(1);
    expect(heading.verdict).toBe('thin');
  });

  it('does not accuse a heading with no proper noun of being generic', () => {
    const heading = report.paragraphs[1]!;
    expect(heading.text).toBe('Our approach');
    expect(paragraphDensities(heading).referentDensity).toBe(0);
    expect(heading.verdict).toBe('thin');
  });

  it('keeps short paragraphs out of the zero-referent flag entirely', () => {
    expect(report.paragraphsWithNoProperNounOrFigure).toEqual([]);
  });

  it('still judges a real paragraph in the same document', () => {
    expect(report.paragraphs[2]!.verdict).toBe('thin');
    expect(report.paragraphs).toHaveLength(3);
  });

  it('flags a short generic paragraph once it is long enough to mean something', () => {
    const long = analyzeProse(
      'This comprehensive initiative will leverage cutting-edge methodologies to empower ' +
        'learners and foster meaningful engagement across a myriad of vibrant communities.',
    );
    expect(long.paragraphs[0]!.verdict).toBe('generic');
    expect(long.paragraphsWithNoProperNounOrFigure).toEqual([0]);
  });
});

/**
 * An unfilled slot is a hole, not a fact. `fillTemplate` renders one as
 * `[TODO: club.callsign — your club's FCC callsign, e.g. W8UM]`, so the hint carries a worked
 * example — and counting it donates a proper noun or a figure to the very paragraph the gap was
 * meant to flag. That is the emptiness check being switched off by emptiness, the same defect
 * Task 12 found when `countFigures` counted the vague quantifier "one", arrived at by a second
 * independent path. Both are pinned.
 */
describe('analyzeProse — an unfilled template gap is not evidence', () => {
  /** Three real gap markers and nothing else: the worst case, a draft that is all holes. */
  const ALL_GAPS = [
    "[TODO: club.callsign — your club's FCC callsign, e.g. W8UM]",
    "[TODO: club.name — the name on your club's ARRL affiliation, e.g. Ann Arbor Amateur Radio Club]",
    '[TODO: project.budgetTotal — the total you are requesting, e.g. 2400]',
  ].join(' ');

  /** A gap embedded in real prose that has no facts of its own. */
  const GAP_IN_PROSE =
    'Our club will run a licensing class next spring at [TODO: club.meetingLocation — where ' +
    'your club meets, e.g. Room 214 of the Engineering Building] and we expect strong ' +
    'attendance from students.';

  it('counts no proper noun and no figure in a paragraph that is only gaps, and flags it', () => {
    const report = analyzeProse(ALL_GAPS);
    const p = report.paragraphs[0]!;
    expect(p.properNounCount).toBe(0);
    expect(p.figureCount).toBe(0);
    expect(report.paragraphsWithNoProperNounOrFigure).toEqual([0]);
    expect(p.verdict).toBe('generic');
  });

  it('does not let a gap donate its example to the paragraph it was meant to flag', () => {
    const report = analyzeProse(GAP_IN_PROSE);
    const p = report.paragraphs[0]!;
    expect(p.properNounCount).toBe(0);
    expect(p.figureCount).toBe(0);
    expect(report.paragraphsWithNoProperNounOrFigure).toEqual([0]);
    expect(p.verdict).toBe('generic');
  });

  it('leaves the applicant their paragraph as written, marker and all', () => {
    expect(analyzeProse(GAP_IN_PROSE).paragraphs[0]!.text).toContain('[TODO: club.meetingLocation');
  });

  it("does not teach the document's proper-noun index a hint's example", () => {
    // "Arbor" appears only inside a hint. Left in, it would enter the mid-sentence-capitalized
    // index and then license a sentence that merely OPENS with that word elsewhere.
    const report = analyzeProse(`${ALL_GAPS}\n\nArbor is the word this sentence opens with today.`);
    expect(report.paragraphs[1]!.properNounCount).toBe(0);
  });

  it('agrees with the template filler about exactly what a gap is', () => {
    const withGap = analyzeProse(GAP_IN_PROSE).paragraphs[0]!;
    const withoutGap = analyzeProse(stripTodoMarkers(GAP_IN_PROSE)).paragraphs[0]!;
    expect(withGap.properNounCount).toBe(withoutGap.properNounCount);
    expect(withGap.figureCount).toBe(withoutGap.figureCount);
    expect(withGap.styleWordHits).toEqual(withoutGap.styleWordHits);
    expect(paragraphDensities(withGap)).toEqual(paragraphDensities(withoutGap));
  });

  it('leaves prose without a gap completely untouched', () => {
    expect(analyzeProse(SPECIFIC)).toEqual(analyzeProse(stripTodoMarkers(SPECIFIC)));
  });
});

/**
 * Task 12's problem 4, and the reason the module reports density rather than counts.
 * "reflected power" is a real ham-radio term and it legitimately hits the style word
 * `reflect`. Prose thick with callsigns, model numbers and figures has earned its verbs:
 * the style density here is ABOVE the alarm threshold and the paragraph is still specific,
 * because the referential counterweight outweighs it.
 */
describe('analyzeProse — density against referents, not a bare count', () => {
  const report = analyzeProse(
    'The station at W8UM shows 12 watts of reflected power on 20 meters, so the SWR at the ' +
      'IC-7300 reads 2.4 to 1. Kyle Brenner W9ABC measured the same reflected power at the ' +
      'DR-2X repeater on March 3, 2026, and traced it to 40 feet of RG-8X.',
  );
  const p = report.paragraphs[0]!;

  it('does report the style word — it never hides a hit', () => {
    expect(p.styleWordHits.filter((h) => h.toLowerCase() === 'reflected')).toHaveLength(2);
  });

  it('crosses the style-density alarm and is still called specific', () => {
    const d = paragraphDensities(p);
    expect(d.styleDensity).toBeGreaterThan(4);
    expect(d.referentDensity).toBeGreaterThan(d.styleDensity);
    expect(p.verdict).toBe('specific');
  });

  it('never enters the zero-referent flag', () => {
    expect(report.paragraphsWithNoProperNounOrFigure).toEqual([]);
  });
});
