import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixturePayload, hasFixture, loadFixture } from '../../test/fixtures.js';
import {
  ARRL_SCHOLARSHIP_LABELS,
  arrlScholarshipDescriptions,
  findAlternatePrefixCollisions,
  findAlternatesWithoutColon,
  parseScholarshipCatalog,
} from './arrl-scholarship-descriptions.js';

const SOURCE_ID = 'arrl-scholarship-descriptions';
const URL = 'http://www.arrl.org/scholarship-descriptions';
const LIVE = '00-www-arrl-org-scholarship-descriptions.html';

const pathological = () => parseScholarshipCatalog(loadFixture(SOURCE_ID, 'pathological.html'), URL);

afterEach(() => {
  vi.restoreAllMocks();
});

// Fix round 3: the reviewer's point was that rounds 1-2 proved the table clean EMPIRICALLY
// (against today's page) but nothing made a future prefix collision structurally impossible or
// loud when it happens. This is the "registry-completeness" pattern applied to labels instead
// of source ids (see sources/registry.test.ts's "every registered source has a fixture
// directory" and "no source module performs I/O" tests): a static invariant over the table
// itself, checked every run, that fails with a diagnosable message instead of a silently
// mangled value.
describe('the no-alternate-is-a-prefix-of-another invariant', () => {
  it('holds for the real ARRL_SCHOLARSHIP_LABELS table shipped in this file', () => {
    expect(findAlternatePrefixCollisions(ARRL_SCHOLARSHIP_LABELS)).toEqual([]);
  });

  // Proves the checker itself is not vacuously trivial — mirrors "deliberately break it and
  // confirm the test goes red", but as a permanent, self-contained test rather than a one-time
  // manual verification step that evaporates once this session ends. Reproduces the exact
  // historical defect: "Region" is a literal prefix of "Regional Preference", the same relation
  // that silently corrupted the Metzger entry before "Regional Preference:" was added.
  it('flags a deliberately reintroduced collision — e.g. a future "Age Requirement:" alongside a stray bare "Age" with no colon', () => {
    const broken: Record<string, string[]> = {
      ...ARRL_SCHOLARSHIP_LABELS,
      Age: ['Age Requirement:', 'Age'], // colon dropped from the bare alternate — reintroduces the bug class
    };
    const collisions = findAlternatePrefixCollisions(broken);
    expect(collisions).toContainEqual({ shorter: 'Age', longer: 'Age Requirement:' });
  });

  it('flags the historical "Region" / "Regional Preference" collision directly', () => {
    const broken: Record<string, string[]> = {
      ...ARRL_SCHOLARSHIP_LABELS,
      Region: ['Region', 'Regions:', 'Regional Preference:'], // colon dropped from "Region" itself
    };
    const collisions = findAlternatePrefixCollisions(broken);
    expect(collisions).toContainEqual({ shorter: 'Region', longer: 'Regional Preference:' });
  });

  it('does not flag unrelated alternates, or two alternates of equal length', () => {
    expect(findAlternatePrefixCollisions({ A: ['Region:'], B: ['Institution:'] })).toEqual([]);
    expect(findAlternatePrefixCollisions({ A: ['Foo:'], B: ['Bar:'] })).toEqual([]);
  });
});

/**
 * THE GAP THE PREFIX CHECK ABOVE DOES NOT COVER, with its confirmed reproduction.
 *
 * A reviewer added `Recipient: ['Recipient']` to ARRL_SCHOLARSHIP_LABELS. Every test in this file
 * stayed green — 33 of 33 — while the real captured page's YASME record gained a fabricated field
 * sliced out of the middle of a sentence:
 *
 *   "Recipient": "is to provide YASME a brief report of his/her Amateur Radio activities…"
 *
 * and `Other` silently lost its tail. No two alternates collided: the alternate collided with the
 * FUNDER'S PROSE ("…the recipient is to provide YASME a brief report…"), which no comparison
 * between alternates can ever see. util/text.ts makes the trailing colon optional and matches at
 * the start of any line, so a BARE alternate matches ordinary prose; a colon-terminated one
 * cannot. 111 of the corpus's records come off this page, so an invented field here is 111
 * chances to publish a requirement the funder never wrote.
 */
describe('the every-alternate-ends-in-a-colon invariant', () => {
  it('holds for the real ARRL_SCHOLARSHIP_LABELS table shipped in this file', () => {
    expect(findAlternatesWithoutColon(ARRL_SCHOLARSHIP_LABELS)).toEqual([]);
  });

  it('flags the exact entry the reviewer used to break the parser, by name', () => {
    const broken: Record<string, string[]> = { ...ARRL_SCHOLARSHIP_LABELS, Recipient: ['Recipient'] };
    expect(findAlternatesWithoutColon(broken)).toEqual(['Recipient: "Recipient"']);
  });

  it('flags a bare alternate added to an EXISTING key, which the prefix check cannot see', () => {
    // "Sponsor" is a proper prefix of nothing in the table and collides with no other alternate,
    // so findAlternatePrefixCollisions returns [] — and it would still match the live page's
    // "Sponsor must be an active QCWA member" prose at the start of a line.
    const broken: Record<string, string[]> = {
      ...ARRL_SCHOLARSHIP_LABELS,
      Other: [...ARRL_SCHOLARSHIP_LABELS.Other, 'Sponsor'],
    };
    expect(findAlternatePrefixCollisions(broken)).toEqual([]);
    expect(findAlternatesWithoutColon(broken)).toEqual(['Other: "Sponsor"']);
  });

  it('accepts a colon-terminated alternate, however ordinary the word', () => {
    expect(findAlternatesWithoutColon({ Recipient: ['Recipient:'], Other: ['Other:'] })).toEqual([]);
  });

  /**
   * The end-to-end half: the two checks together are what make the reproduction impossible, and
   * this asserts the DAMAGE, not just the table. Against the real capture, the bare alternate
   * invents a `Recipient` field on the YASME record and truncates `Other`; the colon-terminated
   * form does neither.
   */
  it.skipIf(!hasFixture(SOURCE_ID, LIVE))(
    'proves the damage on the real page: a bare alternate invents a field, a colon-terminated one does not',
    () => {
      const html = loadFixture(SOURCE_ID, LIVE);
      const yasmeFrom = (labels: Record<string, string[]>) =>
        parseScholarshipCatalog(html, URL, labels).entries.find((e) => /YASME/i.test(e.name));

      const bare = yasmeFrom({ ...ARRL_SCHOLARSHIP_LABELS, Recipient: ['Recipient'] });
      expect(bare?.rawFields.Recipient).toMatch(/^is to provide YASME a brief report/);
      expect(bare?.rawFields.Other).not.toMatch(/brief report/);

      const withColon = yasmeFrom({ ...ARRL_SCHOLARSHIP_LABELS, Recipient: ['Recipient:'] });
      expect(withColon?.rawFields.Recipient).toBeUndefined();
      expect(withColon?.rawFields.Other).toMatch(/brief report/);
    },
  );
});

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

  // Challenge Met's Other field doubles as the regression fixture for fix round 1, finding 3
  // (see below) — its body now ends in two decoy sentences that open a line with a bare
  // "Amount"/"License" and no colon. These three assertions (Field of Study, Award Amount,
  // Number of Awards all exact) were already here before the fix and would themselves have
  // failed under the old bug, since the decoy text used to get appended onto Award Amount.
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

  // Also doubles as fix round 2 regression coverage: Hodges' Other field now ends in a decoy
  // "Region-specific rules..." line (see below), which used to append onto this exact value.
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

  // Fix round 1, finding 1 (CRITICAL): the site-wide "Go Now" application-link CTA has no
  // closing label to stop it, so a naive flatten appends "\nGo Now" to whichever field happens
  // to be last — 88 of 111 live entries (79%) carried it. QCWA's <div class="content"> now ends
  // in exactly this shape: a trailing <p><a title="Go Now" href=".../scholarship-application">
  // Go Now</a></p> after the real bullet list, reproducing the live markup byte-for-byte.
  it('strips the trailing "Go Now" application-link CTA instead of appending it to the last field', () => {
    const qcwa = pathological().entries.find((e) => e.name === 'QCWA Memorial Scholarship');
    expect(qcwa?.rawFields.Other).toBe('Applicant must be sponsored by an active QCWA member.');
    expect(qcwa?.rawText).not.toContain('Go Now');
  });

  // ...and keeps the one thing on that anchor that is not chrome: where to apply. A relative
  // href resolves against the page it was found on, so it lands as the same absolute URL the 87
  // spelled-out anchors carry.
  it('keeps the CTA href as the application URL, absolute even when the page writes it relative', () => {
    const entries = parseScholarshipCatalog(
      '<div class="tabArea f-widget f-accordion"><h3 class="tab">A - D</h3><ul class="accordion">' +
        '<li><p class="title">The Relative Href Scholarship</p><div class="content">' +
        '<p>Award Amount: $1,000</p><p><a href="/scholarship-application">Go Now</a></p>' +
        '</div></li></ul></div>',
      URL,
    ).entries;
    expect(entries[0]?.rawFields.applyUrl).toBe('http://www.arrl.org/scholarship-application');
    expect(entries[0]?.rawText).not.toContain('Go Now');
  });

  // Fix round 1, finding 3 (IMPORTANT): util/text.ts makes the colon after a label optional and
  // matches at the start of any line, not only after a real "Label:" — so the bare 'Amount' and
  // 'License' alternates used to also match ordinary prose that merely started a line with that
  // word. Before the fix, this appended the decoy text onto Award Amount and License Requirement
  // and silently truncated Other to just its first sentence — exactly the shape the reviewer
  // reported. These three exact-value assertions fail under the old bug and pass under the fix.
  it('does not let a bare "Amount"/"License" sentence-opener steal text from Other or pollute a real field', () => {
    const flat = pathological().entries.find((e) => e.name === 'Challenge Met Scholarship');
    expect(flat?.rawFields['Award Amount']).toBe('$1,000');
    expect(flat?.rawFields['License Requirement']).toBe('Technician or higher');
    expect(flat?.rawFields.Other).toBe(
      'Applicant must provide documentation of a diagnosed learning disability.\n' +
        "Amount awarded may vary depending on the review committee's judgement.\n" +
        'License to practice is not required for this field.',
    );
  });

  // Fix round 2 (correcting an inaccuracy in the round 1 report): Region, Institution, Age and
  // Other were ALSO left as bare, colon-optional single-word alternates — the same exploit class
  // as Amount/License, just not yet fixed. Hodges' Other field now ends in four decoy lines, one
  // per label, each opening a line with the bare word and no colon:
  //   "Age is not a factor in this award."
  //   "Region-specific rules may apply in exceptional cases."
  //   "Institution transfer students remain eligible."
  //   "Other scholarships may also be combined with this one."
  // Before the fix these fabricated an Age field, appended onto Region and Institution (see the
  // two tests above), and fragmented Other. Verified red before the fix and green after by
  // temporarily reverting the colon requirement and re-running this file.
  it('does not let bare "Age"/"Region"/"Institution"/"Other" sentence-openers fabricate or corrupt fields', () => {
    const hodges = pathological().entries.find((e) => e.name === 'Larry Hodges Memorial Scholarship');
    // "Age is not a factor..." must not fabricate an Age field — Hodges never had one.
    expect(hodges?.rawFields.Age).toBeUndefined();
    // Institution must stay exactly what it was, not "Any\ntransfer students remain eligible.".
    expect(hodges?.rawFields.Institution).toBe('Any');
    // Other must retain everything, including the trailing "Other scholarships..." decoy line
    // itself (its own bare "Other" must not consume itself as a second label match).
    expect(hodges?.rawFields.Other).toBe(
      'Preference will be given to applicants residing in Louisiana. If no qualified\n' +
        'applicant is identified, the award is open to any eligible applicant. A letter describing an\n' +
        'at-risk-youth turnaround is required.\n' +
        'Age is not a factor in this award.\n' +
        'Region-specific rules may apply in exceptional cases.\n' +
        'Institution transfer students remain eligible.\n' +
        'Other scholarships may also be combined with this one.',
    );
  });

  it('logs every stub rejection by name/first-line so a dropped record is visible', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const result = pathological();
    expect(debugSpy).toHaveBeenCalledTimes(result.stubCount);
    const messages = debugSpy.mock.calls.map((call) => String(call[0]));
    expect(messages.some((m) => m.includes('Chicago FM Club Scholarship'))).toBe(true);
    expect(messages.some((m) => m.includes('Placeholder'))).toBe(true);
  });

  // The lesson of fix round 1: presence/count assertions cannot catch a value silently
  // corrupted by an over-eager or under-eager label match. Pin exact, whole-object field
  // values for a couple of known entries so a future regression that mangles one field but
  // keeps the field *present* still fails a test.
  it('produces exact field values for QCWA end to end, not just presence', () => {
    const qcwa = pathological().entries.find((e) => e.name === 'QCWA Memorial Scholarship');
    expect(qcwa?.rawFields).toEqual({
      'Field of Study': 'Any',
      'License Requirement': 'Any',
      Region: 'Any',
      Institution: 'Accredited degree program',
      'Award Amount': '$3,000',
      'Number of Awards': '19',
      Other: 'Applicant must be sponsored by an active QCWA member.',
      // The "Go Now" CTA's href, kept while its text is stripped. This fixture reproduces the
      // live markup byte-for-byte, CTA included, so the entry carries an application URL.
      applyUrl: 'http://www.arrl.org/scholarship-application',
    });
  });

  it('produces exact field values for YASME end to end, not just presence', () => {
    const yasme = pathological().entries.find((e) => e.name === 'YASME Foundation Scholarship');
    expect(yasme?.rawFields).toEqual({
      'Field of Study': 'Sciences or Engineering',
      'License Requirement': 'General or higher, licensed at least two years',
      Region: 'Any',
      Institution: 'Any accredited institution',
      'Award Amount': '$5,000',
      'Number of Awards': 'Three',
      Other:
        'Applicant must rank in the top 5 to 10 percent of the class and submit a\n' +
        'year-end activity report.',
    });
  });
});

// Fix round 1, finding 2 (IMPORTANT): a real entry whose labels are ALL typo'd beyond what
// looseLabelPattern's whitespace tolerance and the explicit alternates recover
// (recognisedFieldCount === 0, same shape as a stub) must not be silently dropped — this site's
// typo history ("R egion", "License   Requirement", "Scholarshps") is real and ongoing, and
// expectedMinRecords=100 leaves 11 records of slack before parse_yield_dropped would ever notice
// one going missing. Deliberately a standalone, hand-built HTML snippet rather than an addition
// to the shared pathological.html fixture: crawl/runner.test.ts pins that fixture's real-entry
// count at exactly 6, and this scenario needs its own dedicated, uncoupled page.
const TYPO_STORM_URL = 'http://www.arrl.org/scholarship-descriptions';
const TYPO_STORM_HTML = `<!DOCTYPE html>
<html><body>
<div class="tabArea f-widget f-accordion">
  <h3 class="tab">A - D</h3>
  <ul class="accordion">
    <li>
      <p class="title"><a href="#">Typo Storm Memorial Scholarship</a></p>
      <div class="content">
        <p>&bull; Feild of Study: Any<br>
        &bull; Lisence Requiremnt: General or higher<br>
        &bull; Regoin: Any<br>
        &bull; Institooshun: Any accredited institution<br>
        &bull; Awrd Amunt: $2,500<br>
        &bull; Numbr of Awards: 2<br>
        &bull; Othr: Preference given to applicants pursuing wireless engineering.</p>
      </div>
    </li>
    <li>
      <p class="title"><a href="#">Untouched Stub</a></p>
      <div class="content"><p>&nbsp;</p></div>
    </li>
  </ul>
</div>
</body></html>`;

describe('the stub-rescue safety net (dollar amount / date corroboration)', () => {
  it('rescues a real entry whose labels are all typoed beyond recognition when a dollar amount corroborates it', () => {
    const result = parseScholarshipCatalog(TYPO_STORM_HTML, TYPO_STORM_URL);
    expect(result.stubCount).toBe(1); // only "Untouched Stub" (nbsp-only body) is dropped
    expect(result.entries).toHaveLength(1);
    const stormed = result.entries[0];
    expect(stormed.name).toBe('Typo Storm Memorial Scholarship');
    const recognised = Object.keys(stormed.rawFields).filter((k) => k !== '__preamble');
    expect(recognised).toEqual([]);
    expect(stormed.rawText).toContain('$2,500');
  });

  it('does not log the rescued entry as a stub, but does log the genuine one', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    parseScholarshipCatalog(TYPO_STORM_HTML, TYPO_STORM_URL);
    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(String(debugSpy.mock.calls[0][0])).toContain('Untouched Stub');
    expect(String(debugSpy.mock.calls[0][0])).not.toContain('Typo Storm');
  });
});

// Discovered while re-verifying the live page for fix round 2: requiring a colon on the bare
// "Region" alternate (so it can no longer match "Regional" as a substring) also stopped an
// EXISTING silent false positive — the live "Edmond A. Metzger Scholarship" entry uses the label
// "Regional Preference:", which the old colon-optional "Region" alternate matched as a substring,
// capturing "al Preference: Resident of ARRL Central Division (IL, IN, WI)" (garbage prefix and
// all) as its Region value. The colon requirement alone would have left this entry's Region
// unrecovered instead, so "Regional Preference:" was added as an explicit alternate to recover
// the clean value. Standalone snippet, not the shared fixture, for the same reason as the typo
// storm test above.
const REGIONAL_PREFERENCE_HTML = `<!DOCTYPE html>
<html><body>
<div class="tabArea f-widget f-accordion">
  <h3 class="tab">E - L</h3>
  <ul class="accordion">
    <li>
      <p class="title"><a href="#">Regional Preference Scholarship</a></p>
      <div class="content">
        <ul>
          <li>License Requirement: Any active Amateur Radio License Class</li>
          <li>Regional Preference: Resident of ARRL Central Division (IL, IN, WI)</li>
          <li>Field of Study: Any</li>
        </ul>
      </div>
    </li>
  </ul>
</div>
</body></html>`;

describe('the "Regional Preference" label variant', () => {
  it('recovers the clean value instead of matching "Region" as a substring of "Regional"', () => {
    const result = parseScholarshipCatalog(REGIONAL_PREFERENCE_HTML, TYPO_STORM_URL);
    const entry = result.entries.find((e) => e.name === 'Regional Preference Scholarship');
    expect(entry?.rawFields.Region).toBe('Resident of ARRL Central Division (IL, IN, WI)');
    expect(entry?.rawFields.Region).not.toContain('al Preference');
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

  // Fix round 1, finding 1: the "Go Now" application-link CTA appeared in div.content on 88 of
  // 111 (79%) live entries, with no closing label to stop it, and used to append onto whichever
  // field happened to be last. It must be gone from every field now, not merely reduced.
  it('strips the "Go Now" CTA from every one of the 111 live entries', () => {
    const { entries } = parseScholarshipCatalog(loadFixture(SOURCE_ID, LIVE), URL);
    const polluted = entries.filter((e) =>
      Object.values(e.rawFields).some((v) => /go\s*now/i.test(v)),
    );
    expect(polluted.map((e) => e.name)).toEqual([]);
  });

  /**
   * CLOSE-OUT REVIEW B2. Stripping the CTA's TEXT was right; discarding its HREF was not. The
   * capture carries `href="http://www.arrl.org/scholarship-application"` 87 times and
   * `href="/scholarship-application"` 3 times — 89 of them inside an entry's own accordion body,
   * the 90th in the sidebar callout. All 111 records used to publish
   * `applyUrl: http://www.arrl.org/scholarship-descriptions`, the catalogue page the reader was
   * already looking at, because normalize/ had nothing else to fall back to.
   */
  it('keeps the application href off the CTA it strips, for the 89 entries that carry one', () => {
    const { entries } = parseScholarshipCatalog(loadFixture(SOURCE_ID, LIVE), URL);
    const withApply = entries.filter((e) => e.rawFields.applyUrl !== undefined);
    expect(withApply).toHaveLength(89);
    for (const e of withApply) {
      expect(e.rawFields.applyUrl, e.name).toBe('http://www.arrl.org/scholarship-application');
    }
  });

  // The other 22 entries state no route of their own. The page's sidebar does — "Scholarship
  // Application … Complete your application now!" — but attributing a page-level callout to an
  // entry that does not carry it is an inference, not a reading, so those keep the catalogue URL
  // and the record says so by omission.
  it('writes no applyUrl for an entry whose own body names no route', () => {
    const { entries } = parseScholarshipCatalog(loadFixture(SOURCE_ID, LIVE), URL);
    const without = entries.filter((e) => e.rawFields.applyUrl === undefined);
    expect(without).toHaveLength(entries.length - 89);
    expect(without.map((e) => e.name)).toContain('The Louisiana Memorial Scholarship');
  });
});
