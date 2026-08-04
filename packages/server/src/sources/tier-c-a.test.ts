import { describe, expect, it } from 'vitest';
import { fixturePayload } from '../../test/fixtures.js';
import { type NormalizeContext, normalizeRaw } from '../normalize/index.js';
import { extractGender } from '../normalize/axes/index.js';
import { TIER_C_A_SOURCES, austinArc, qcwa, sara, ylrl } from './tier-c-a.js';
import { parseProseWindow } from './tier-c-b.js';
import { programIdFor } from './util/ids.js';

// The committed REAL captures under fixtures/<id>/00-*.html — pages actually pulled from the
// funders' own sites on 2026-08-03 through the production fetcher, as opposed to the synthetic
// pathological.html each `describe` above drives. Plan 2's review found that every test in this
// file drove only the synthetic fixture, which is how two of these four sources shipped parsers
// that return ZERO records from their own live pages while the suite stayed green: "the tests
// measure agreement between a parser and its author, not between a parser and the web." Each
// block below asserts a record COUNT plus exact field values read off the raw HTML.
const real = (id: string, file: string, url: string) => fixturePayload(id, file, url);

describe('qcwa', () => {
  const raws = qcwa.parse([
    fixturePayload('qcwa', 'pathological.html', 'https://www.qcwa.org/scholarship-program.htm'),
  ]);

  it('captures the $3,000 award and the mandatory QCWA sponsor', () => {
    expect(raws[0].rawFields.amount).toBe('$3,000');
    expect(raws[0].rawFields.sponsor).toMatch(/active QCWA member/i);
  });

  it('captures that the intake is ARRL’s portal, not QCWA’s', () => {
    expect(raws[0].rawFields.applyNote).toMatch(/ARRL/);
    expect(raws[0].rawFields.deadlineNote).toMatch(/first week of January/i);
  });
});

describe('qcwa (REAL fixture — this source parsed ZERO records from its own live page)', () => {
  // Raw HTML, fixtures/qcwa/00-www-qcwa-org-scholarship-program-htm.html:
  //   line 86:  "administered in partnership with the <strong>ARRL Foundation</strong>"
  //   line 88:  "Each applicant must be recommended by an active QCWA member"
  //   line 89:  "must be received by the ARRL Foundation <strong>before the first week in
  //             January</strong> each year"
  //   line 94:  https://www.arrl.org/scholarship-descriptions
  //   line 103: "The first QCWA scholarship was a $500 award given in 1978. As of 2024,
  //             <strong>15 scholarships totaling $57,000</strong> were awarded."
  // There is NO $3,000 anywhere on the page, and `amount` used to be a REQUIRED field pinned to
  // that literal — so the parser returned [] against the very page it exists to read, and the
  // page says "recommended by" where the parser demanded "sponsored by" and "first week IN
  // January" where it demanded "first week OF January".
  const raws = qcwa.parse([
    real(
      'qcwa',
      '00-www-qcwa-org-scholarship-program-htm.html',
      'https://www.qcwa.org/scholarship-program.htm',
    ),
  ]);

  it('parses exactly one record from the live page (it used to parse none)', () => {
    expect(raws).toHaveLength(1);
  });

  it('reads the QCWA-member requirement as the page words it — "recommended by", not "sponsored by"', () => {
    expect(raws[0].rawFields.sponsor).toBe(
      'recommended by an active QCWA member, and applications must be received by the ARRL ' +
        'Foundation before the first week in January each year.',
    );
  });

  it('reads the deadline note as "first week IN January", the page\'s actual wording', () => {
    expect(raws[0].rawFields.deadlineNote).toBe('before the first week in January each year.');
    expect(raws[0].rawFields.requestWindow).toBe(
      'on or after October 31 of each year from the ARRL Foundation Committee.',
    );
  });

  it('captures the exact ARRL intake URL the page prints', () => {
    expect(raws[0].rawFields.applyUrl).toBe('https://www.arrl.org/scholarship-descriptions');
    expect(raws[0].rawFields.applyNote).toBe(
      'administered in partnership with the ARRL Foundation.',
    );
  });

  // The whole point of dropping the hardcoded $3,000: the live page publishes no per-award
  // figure at all, only a historical first award and two totals. Publishing any of those as the
  // award size would be a fabrication, and 15 x $3,000 = $45,000 does not even reconcile with
  // the $57,000 the page reports for those 15 awards.
  it('publishes NO amount, because the live page publishes none', () => {
    expect(raws[0].rawFields.amount).toBeUndefined();
    expect(raws[0].rawText).toMatch(/\$500 award given in 1978/);
    expect(raws[0].rawText).toMatch(/15 scholarships totaling \$57,000/);
  });

  it('never mistakes a historical or aggregate figure for the award size', () => {
    expect(raws[0].rawFields.history).toBe('As of 2024, 15 scholarships totaling $57,000 were awarded.');
    for (const value of Object.values(raws[0].rawFields)) {
      expect(value).not.toMatch(/\$930,350/);
    }
  });

  it('carries no farweb.org reference — the live page does not link it, contrary to the old note', () => {
    expect(raws[0].rawText).not.toMatch(/farweb/i);
    expect(qcwa.notes).toMatch(/carries NO farweb\.org link/);
  });
});

describe('ylrl', () => {
  const raws = ylrl.parse([fixturePayload('ylrl', 'pathological.html', 'https://ylrl.net/Scholarships/')]);

  // The three names below are now CANONICAL — fixed in YLRL_AWARDS, not lifted from whatever
  // the page happens to call each award. The synthetic fixture writes two of them without the
  // word "Memorial"; the live page writes all three inside a sentence that also carries the
  // dollar figure. Deriving identity from either would make one program's id churn whenever its
  // page wording or its award amount changed.
  it('emits one record per named scholarship plus the page record', () => {
    const names = raws.map((r) => r.name);
    expect(names).toContain('Ethel Smith K4LMB Memorial Scholarship');
    expect(names).toContain('Mary Lou Brown NM7N Memorial Scholarship');
    expect(names).toContain('Marte Wessel K0EPE Memorial Scholarship');
    expect(raws.length).toBeGreaterThanOrEqual(3);
  });

  it('mints a stable externalKey that does not contain the award amount or page wording', () => {
    expect(raws.map((r) => r.externalKey).sort()).toEqual([
      'ylrl-ethel-smith-k4lmb',
      'ylrl-marte-wessel-k0epe',
      'ylrl-mary-lou-brown-nm7n',
      'ylrl-scholarships',
    ]);
  });

  it('captures each award amount', () => {
    const wessel = raws.find((r) => r.name.includes('Wessel'));
    expect(wessel?.rawFields.amount).toBe('$1,500');
  });

  it('carries the female-only eligibility that drives the gender constraint axis', () => {
    expect(raws.some((r) => /women|female|YL/i.test(r.rawText))).toBe(true);
  });

  it('has expectedMinRecords 3, one per named scholarship', () => {
    expect(ylrl.expectedMinRecords).toBe(3);
  });

  // Regression coverage for the fixed-slice-window bug: a 3-line lookahead ran PAST the next
  // <h2>, so each named scholarship's summary/amount silently absorbed its neighbor's heading
  // and award figure. Assert each of the three records' OWN amount and summary, with no trace
  // of a sibling's name or figure — presence checks alone (as the old suite had) cannot catch
  // this, because the bled-in figure was coincidentally often correct too.
  describe('no cross-record bleed (regression)', () => {
    const named = raws.filter((r) => r.rawFields.scope === 'named_scholarship');

    it('emits exactly the three named records, each with its own exact amount', () => {
      expect(named).toHaveLength(3);
      const byName = Object.fromEntries(named.map((r) => [r.name, r]));
      expect(byName['Ethel Smith K4LMB Memorial Scholarship'].rawFields.amount).toBe('$2,500');
      expect(byName['Mary Lou Brown NM7N Memorial Scholarship'].rawFields.amount).toBe('$2,500');
      expect(byName['Marte Wessel K0EPE Memorial Scholarship'].rawFields.amount).toBe('$1,500');
    });

    // The summaries below now lead with the line that NAMES the award, because on the live page
    // that line is the content ("The Ethel Smith, K4LMB, Memorial Scholarship awards $2,500.")
    // rather than a bare <h2> title. What these assertions are for is unchanged: each record
    // carries its OWN figure and detail and no trace of a sibling.
    it('gives Ethel Smith her own summary with no Mary Lou Brown bleed', () => {
      const ethel = named.find((r) => r.name.includes('Ethel Smith'));
      expect(ethel?.rawFields.summary).toBe('Ethel Smith K4LMB Memorial Scholarship Award: $2,500.');
      expect(ethel?.rawText).not.toMatch(/Mary Lou Brown/);
    });

    it('gives Mary Lou Brown her own summary with no Marte Wessel bleed', () => {
      const mlb = named.find((r) => r.name.includes('Mary Lou Brown'));
      expect(mlb?.rawFields.summary).toBe('Mary Lou Brown NM7N Scholarship Award: $2,500.');
      expect(mlb?.rawText).not.toMatch(/Marte Wessel/);
    });

    it("keeps Marte Wessel's part-time-working-full-time detail intact", () => {
      const wessel = named.find((r) => r.name.includes('Wessel'));
      expect(wessel?.rawFields.summary).toBe(
        'Marte Wessel K0EPE Scholarship Award: $1,500. For part-time students working full-time.',
      );
    });
  });

  // Regression coverage for the reach bug: the document-level women-only restriction sits ABOVE
  // the first <h2>, so the fixed-window parser's per-record rawFields never carried it — only
  // the separate whole-page record did. `raws.some(...)` across ALL records (as the old suite
  // had) passed because of that unrelated page record, while all three real scholarships quietly
  // published as unrestricted. Assert the restriction on EACH named record individually, and
  // that it survives all the way through the shared gender-axis extractor as a HARD constraint —
  // the actual mechanism that would otherwise let these three publish as open to everyone.
  describe('female-only restriction reaches every named record (regression)', () => {
    const named = raws.filter((r) => r.rawFields.scope === 'named_scholarship');

    it('puts the eligibility sentence on all three named records, not just the page record', () => {
      expect(named).toHaveLength(3);
      for (const r of named) {
        expect(r.rawFields.eligibility).toBe('licensed women amateur radio operators worldwide.');
      }
    });

    it('drives a hard female-only gender constraint for all three via extractGender', () => {
      for (const r of named) {
        const constraints = extractGender(r);
        expect(constraints).toHaveLength(1);
        expect(constraints[0].hard).toBe(true);
        expect(constraints[0].spec).toEqual({ axis: 'gender', allowed: ['female'] });
      }
    });
  });
});

describe('ylrl (REAL fixture — this source parsed ZERO records from its own live page)', () => {
  // Raw HTML, fixtures/ylrl/00-ylrl-net-scholarships.html line 992, all inside ONE paragraph:
  //   "The <strong>Ethel Smith, K4LMB, Memorial Scholarship</strong> awards <strong>$2,500</strong>."
  //   "The <strong>Mary Lou Brown, NM7N, Memorial Scholarship</strong> awards <strong> $2,500</strong>."
  //   "The <strong>Martha “Marte” Wessel, K0EPE, Memorial Scholarship</strong> awards <strong> $1,500</strong>."
  //   "• Applicant must be female."
  //   "• Applicant must have an Amateur Radio License."
  //   "• There are no residency restrictions. Non-U.S. Amateurs are eligible."
  //   "• Preference will be given to YLRL members."
  // There are no per-scholarship headings at all, so the old whole-line heading regex matched
  // nothing; and the restriction is the bare bullet "Applicant must be female", not the
  // "licensed women…" prose the old required `eligibility` pattern demanded. Both failed, so the
  // source yielded nothing. Had only the heading half been fixed, all three genuinely
  // female-only scholarships would have published as open to everyone.
  const raws = ylrl.parse([
    real('ylrl', '00-ylrl-net-scholarships.html', 'https://ylrl.net/Scholarships/'),
  ]);
  const named = raws.filter((r) => r.rawFields.scope === 'named_scholarship');

  it('parses four records — three named scholarships plus the page record (it used to parse none)', () => {
    expect(raws).toHaveLength(4);
    expect(named).toHaveLength(3);
    expect(ylrl.expectedMinRecords).toBe(3);
  });

  it('reads the three award amounts the live page states', () => {
    const byKey = Object.fromEntries(named.map((r) => [r.externalKey, r]));
    expect(byKey['ylrl-ethel-smith-k4lmb'].rawFields.amount).toBe('$2,500');
    expect(byKey['ylrl-mary-lou-brown-nm7n'].rawFields.amount).toBe('$2,500');
    expect(byKey['ylrl-marte-wessel-k0epe'].rawFields.amount).toBe('$1,500');
  });

  it('matches "Martha “Marte” Wessel, K0EPE" through the curly quotes and the comma', () => {
    const wessel = named.find((r) => r.externalKey === 'ylrl-marte-wessel-k0epe');
    expect(wessel?.rawFields.summary).toBe(
      'The Martha “Marte” Wessel, K0EPE, Memorial Scholarship awards $1,500. • The Martha ' +
        '“Marte” Wessel, K0EPE scholarship is intended for a part-time student of an accredited ' +
        'educational institution* who is working full-time. Full time work includes a ' +
        'stay-at-home parent or caregiver. High School students are exempt from the full-time ' +
        'work requirement.',
    );
  });

  it("gives Ethel Smith her own figure and the page's own shared full-time sentence", () => {
    const ethel = named.find((r) => r.externalKey === 'ylrl-ethel-smith-k4lmb');
    expect(ethel?.rawFields.summary).toBe(
      'The Ethel Smith, K4LMB, Memorial Scholarship awards $2,500. • The Ethel Smith, K4LMB and ' +
        'Mary Lou Brown, NM7N scholarships are intended for full-time students. For these ' +
        'scholarships, applicants must intend to seek a Bachelor’s or Graduate degree from an ' +
        'accredited college or university.',
    );
    // Not bleed: the live page really does write that one sentence about both scholarships, so
    // it is correctly attributed to both records rather than to whichever came first.
    expect(ethel?.rawFields.summary).not.toMatch(/Marte|Wessel/);
  });

  it('puts BOTH hard restrictions — female and licensed — on all three named records', () => {
    for (const r of named) {
      expect(r.rawFields.eligibility).toBe(
        'Applicant must be female. Applicant must have an Amateur Radio License.',
      );
    }
  });

  it('drives a hard female-only gender constraint for all three off the live wording', () => {
    for (const r of named) {
      const constraints = extractGender(r);
      expect(constraints).toHaveLength(1);
      expect(constraints[0].hard).toBe(true);
      expect(constraints[0].spec).toEqual({ axis: 'gender', allowed: ['female'] });
      expect(constraints[0].rawText).toBe('Applicant must be female.');
    }
  });

  it('records that non-US applicants are eligible and YLRL membership is only a preference', () => {
    const page = raws.find((r) => r.externalKey === 'ylrl-scholarships');
    expect(page?.rawFields.residency).toBe(
      'There are no residency restrictions. Non-U.S. Amateurs are eligible.',
    );
    expect(page?.rawFields.membershipPreference).toBe('Preference will be given to YLRL members.');
  });

  it('points at ylrl.net/apply/, because the scholarships page states no dates at all', () => {
    for (const r of raws) expect(r.rawFields.detailUrl).toBe('https://ylrl.net/apply/');
    expect(raws.every((r) => !/\b(deadline is|closes on)\b/i.test(r.rawFields.summary ?? ''))).toBe(
      true,
    );
  });
});

describe('austin-arc', () => {
  const url = 'https://austinhams.org/scholarships/';

  it('captures the May 1 - Jul 31 window and the seven Central Texas counties', () => {
    const raws = austinArc.parse([fixturePayload('austin-arc', 'pathological.html', url)]);
    expect(raws[0].rawFields.window).toMatch(/May 1 through July 31/i);
    expect(raws[0].rawFields.counties).toMatch(/Travis/);
  });

  it('has expectedMinRecords 0 — an empty scrape here is CORRECT for eight months a year', () => {
    expect(austinArc.expectedMinRecords).toBe(0);
    expect(austinArc.notes).toMatch(/No opportunities available/i);
    expect(austinArc.notes).toMatch(/Aug(?:ust)? 1/);
  });

  it('returns [] on the closed-window page without throwing', () => {
    expect(austinArc.parse([fixturePayload('austin-arc', 'empty-window.html', url)])).toEqual([]);
  });
});

describe('austin-arc (REAL fixture)', () => {
  // Raw HTML, fixtures/austin-arc/00-austinhams-org-scholarships.html:
  //   line 58: "Applications open <strong>May 1</strong> and close <strong>July 31</strong> each year."
  //   line 58: "Travis, Bastrop, Blanco, Burnet, Caldwell, Hays, and Williamson</strong> counties."
  //   line 48: href=https://grants.austinhams.org   (UNQUOTED attribute)
  // The page is headed "Club Scholarships" and names no individual award: "Copeland" and
  // "Greenwood" appear nowhere on it.
  const raws = austinArc.parse([
    real('austin-arc', '00-austinhams-org-scholarships.html', 'https://austinhams.org/scholarships/'),
  ]);

  it('parses one record from the live page even three days after the window closed', () => {
    expect(raws).toHaveLength(1);
    expect(austinArc.expectedMinRecords).toBe(0);
  });

  it('names the program what the live page names it, not two awards it never mentions', () => {
    expect(raws[0].name).toBe('Austin ARC Club Scholarships');
    expect(raws[0].rawText).not.toMatch(/Copeland|Greenwood/i);
  });

  it('captures the window as a whole sentence rather than a "May 1 and close July 31" fragment', () => {
    expect(raws[0].rawFields.window).toBe('Applications open May 1 and close July 31 each year.');
  });

  it('captures all seven Central Texas counties verbatim, Oxford comma and all', () => {
    expect(raws[0].rawFields.counties).toBe(
      'Travis, Bastrop, Blanco, Burnet, Caldwell, Hays, and Williamson counties.',
    );
  });

  it('reads the apply portal out of an unquoted href attribute', () => {
    expect(raws[0].rawFields.detailUrl).toBe('https://grants.austinhams.org');
  });

  it('publishes no amount, because the live page contains no dollar figure at all', () => {
    expect(raws[0].rawFields.amount).toBeUndefined();
    expect(raws[0].rawText).not.toMatch(/\$/);
  });

  /**
   * THE WINDOW IS READ, AND DELIBERATELY NOT RESOLVED.
   *
   * Verbatim, from the flattened capture, in all three places the club states it:
   *
   *   L79 "Applications open May 1 and close July 31 each year."
   *   L87 "Submit your application online through our grants portal between May 1 and July 31."
   *   L92 "Applications are accepted each year from May 1 through July 31 via our grants portal."
   *
   * Not one of them names a year, and neither does anything else on the page — see the next test.
   * "each year" is the club stating an ANNUAL RULE, and the channel for a rule is a RECUR
   * `annual_window window=05-01..07-31` directive, which carries no year by construction.
   * `rawFields.opensAt`/`closesAt` mean something else: ONE dated window that is never repeated.
   * Writing 2026 into that channel would put a date on the calendar under the club's name that the
   * club has never printed, so the month-days are read and the record publishes no date.
   */
  it('reads 05-01..07-31 off the page and refuses to invent the year it never states', () => {
    const window = parseProseWindow(raws[0].rawFields.window!);
    expect(window).toEqual({ opensOn: '05-01', closesOn: '07-31', yearUnstated: true });
    expect(raws[0].rawFields.opensAt).toBeUndefined();
    expect(raws[0].rawFields.closesAt).toBeUndefined();
  });

  /**
   * THE EVIDENCE FOR THE REFUSAL, taken off the capture rather than asserted. The page's ONLY
   * four-digit number is its footer copyright, "© 2026 Austin Amateur Radio Club. All rights
   * reserved." A site copyright is not a deadline, and a parser that reached for the nearest year
   * on the page would have turned that one into a July 2026 close date.
   */
  it('has no year anywhere on the page except the footer copyright', () => {
    const years = raws[0].rawText.match(/\b(?:19|20)\d{2}\b/g) ?? [];
    expect(years).toEqual(['2026']);
    expect(raws[0].rawText).toMatch(/© 2026 Austin Amateur Radio Club/);
  });

  /**
   * The consequence, stated as a test so it cannot silently change: with no resolvable window and
   * no RECUR directive for this source, `inferStatus`'s window gate has no schedule to ask, and
   * `unknown` — not `open` — is what the record publishes. That is a worse answer than `closed`
   * (the capture was taken three days after the window shut) and a much better one than `open`.
   */
  it('stays unknown rather than open, because nothing here can date the window', () => {
    const ctx: NormalizeContext = {
      sourceId: 'austin-arc',
      funderId: 'austin-arc',
      klass: 'ham_scholarship',
      tier: 'C',
      nowISO: '2026-08-02T00:00:00.000Z',
      verificationMethod: 'live_fetch',
      mintId: programIdFor,
    };
    const program = normalizeRaw(raws[0], ctx);
    expect(program.trust.status).toBe('unknown');
    expect(program.deadline.note).not.toContain('published by the funder');
  });
});

describe('sara', () => {
  const raws = sara.parse([
    fixturePayload('sara', 'pathological.html', 'https://www.radio-astronomy.org/grants'),
  ]);

  it('captures the 5th-grade-through-college audience and the email intake', () => {
    expect(raws[0].rawFields.audience).toMatch(/5th grade/i);
    expect(raws[0].rawFields.applyNote).toBe('grants@radio-astronomy.org');
  });

  it('records that there is no deadline anywhere on the page', () => {
    expect(sara.notes).toMatch(/rolling/i);
    expect(raws[0].rawFields.window).toBeUndefined();
  });
});

describe('sara (REAL fixture)', () => {
  // Raw HTML, fixtures/sara/00-www-radio-astronomy-org-grants.html — the entire program is one
  // <p>:
  //   "The Society of Amateur Radio Astronomers provides funds in support of student projects.
  //    The funds will be divided up into several small grants of no more than $200 each or more,
  //    with the approval of the grant committee, to ensure that the money reaches the largest
  //    number of students. Preference will be given to students 5th grade through college and to
  //    new and innovative ideas. UPDATE: Teachers are now eligible to apply…"
  //   "Email the completed form to grants at radio-astronomy.org"
  // That last line is the whole reason the old `@`-anchored applyNote pattern found nothing on
  // the live page: SARA spells the address out to defeat address harvesters.
  const raws = sara.parse([
    real('sara', '00-www-radio-astronomy-org-grants.html', 'https://www.radio-astronomy.org/grants'),
  ]);

  it('parses exactly one record from the live page', () => {
    expect(raws).toHaveLength(1);
  });

  it('recovers the intake address even though the page writes " at " instead of "@"', () => {
    expect(raws[0].rawFields.applyNote).toBe('grants at radio-astronomy.org');
  });

  it('keeps "no more than", so the $200 reads as a ceiling rather than a flat award', () => {
    expect(raws[0].rawFields.amount).toBe(
      'no more than $200 each or more, with the approval of the grant committee, to ensure that ' +
        'the money reaches the largest number of students.',
    );
  });

  it('keeps "Preference will be given to", so 5th-grade-through-college is not published as a bar', () => {
    expect(raws[0].rawFields.audience).toBe(
      'Preference will be given to students 5th grade through college and to new and innovative ideas.',
    );
  });

  it('records that teachers became eligible by a later UPDATE line', () => {
    expect(raws[0].rawFields.teachers).toBe(
      'UPDATE: Teachers are now eligible to apply for grants to bring radio astronomy to the classroom.',
    );
  });

  it('finds no deadline anywhere on the live page, so the rolling kind is not a guess', () => {
    expect(raws[0].rawFields.window).toBeUndefined();
    expect(raws[0].rawFields.closesAt).toBeUndefined();
    expect(raws[0].rawText).not.toMatch(/deadline|due (?:by|date)|apply by/i);
  });

  // Radio astronomy is genuinely in scope for this product, so this asserts the funder is real
  // and its subject matter is the intended one — not the unrelated broadcast sense of "radio".
  it('is the radio-astronomy funder it claims to be', () => {
    expect(raws[0].rawFields.summary).toBe(
      'The Society of Amateur Radio Astronomers provides funds in support of student projects.',
    );
    expect(raws[0].rawText).toMatch(/Radio JOVE/);
    expect(raws[0].rawText).toMatch(/SuperSID/);
  });
});

describe('the group', () => {
  it('exports all four modules with unique ids', () => {
    expect(TIER_C_A_SOURCES.map((m) => m.id).sort()).toEqual([
      'austin-arc',
      'qcwa',
      'sara',
      'ylrl',
    ]);
  });
});
