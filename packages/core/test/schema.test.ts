import { describe, expect, it } from 'vitest';
import {
  constraintSpecSchema,
  profileSchema,
  programSchema,
} from '../src/schema.js';
import { makeConstraint, makeOrg, makeProgram, makeStudent } from './fixtures.js';

describe('zod mirrors of CONTRACT §3', () => {
  it('accepts a fully populated Program', () => {
    const program = makeProgram();
    const parsed = programSchema.parse(program);
    expect(parsed.id).toBe(program.id);
    expect(parsed.constraints).toHaveLength(program.constraints.length);
  });

  it('round-trips a Program through JSON without loss', () => {
    const program = makeProgram();
    const reparsed = programSchema.parse(JSON.parse(JSON.stringify(program)));
    expect(reparsed).toEqual(program);
  });

  it('rejects a Program with an unknown opportunity class', () => {
    const bad = { ...makeProgram(), klass: 'ham_lottery' };
    expect(() => programSchema.parse(bad)).toThrow();
  });

  /**
   * CLOSE-OUT REVIEW I5, THE STORE-SIDE HALF.
   *
   * `applyUrl` was a bare `z.string()`, and `POST /api/inbox/:id/decision` validates an
   * admin-edited candidate with nothing but `programSchema`. So `javascript:…` was a storable
   * value, and the detail page renders `applyUrl` as an `<a href>`. All 703 stored apply URLs are
   * absolute http/https today (591 https, 112 http, 0 unparseable), which is precisely why this
   * is worth closing now rather than after a record proves it.
   *
   * The rule is the same allowlist the renderer applies: an absolute http(s) URL, or the key
   * absent. It is NOT `z.string().url()` — zod's `.url()` accepts `javascript:alert(1)`.
   */
  it('accepts an absolute http(s) apply URL, and lets the key be absent', () => {
    for (const applyUrl of [
      'https://www.arrl.org/club-grant-program',
      'http://www.arrl.org/club-grant-program',
      'https://example.test:8443/apply?x=1#top',
    ]) {
      expect(programSchema.parse({ ...makeProgram(), applyUrl }).applyUrl).toBe(applyUrl);
    }
    const { applyUrl: _dropped, ...withoutUrl } = makeProgram();
    expect(programSchema.parse(withoutUrl).applyUrl).toBeUndefined();
  });

  it('refuses to store an apply URL no page can safely render as a link', () => {
    for (const applyUrl of [
      'javascript:alert(document.cookie)',
      'JavaScript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      // Protocol-relative: `new URL()` throws on it, and the browser resolves it to the hijacked
      // farweb.org. This is the shape the web-side blocklist passed through as "not blocked".
      '//www.farweb.org/scholarships',
      '/apply',
      'not a url',
      '',
    ]) {
      expect(() => programSchema.parse({ ...makeProgram(), applyUrl }), applyUrl).toThrow();
    }
  });

  /**
   * THE SAME ALLOWLIST, ON THE OTHER TWO FIELDS `SourceLink` RENDERS AS AN ANCHOR.
   *
   * `trust.sourceUrl` is required (never optional — every record has a source page) and
   * `aiPolicy.url` is optional exactly like `applyUrl` (absent on every record whose funder has
   * not published an AI policy). Both were bare `z.string()` until this fix, both go straight to
   * `SourceLink` with no `Opportunity.tsx`-level guard the way `applyUrl` has, and both are
   * latent today — every stored value happens to parse — which is exactly why this is worth
   * closing before a record proves it rather than after.
   */
  it('accepts an absolute http(s) trust.sourceUrl, which is required', () => {
    for (const sourceUrl of [
      'https://www.arrl.org/club-grant-program',
      'http://www.arrl.org/club-grant-program',
      'https://example.test:8443/apply?x=1#top',
    ]) {
      const program = makeProgram({ trust: { ...makeProgram().trust, sourceUrl } });
      expect(programSchema.parse(program).trust.sourceUrl).toBe(sourceUrl);
    }
  });

  it('refuses to store a trust.sourceUrl no page can safely render as a link', () => {
    for (const sourceUrl of [
      'javascript:alert(document.cookie)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      '//www.farweb.org/scholarships',
      '/apply',
      'not a url',
      '',
    ]) {
      const program = makeProgram({ trust: { ...makeProgram().trust, sourceUrl } });
      expect(() => programSchema.parse(program), sourceUrl).toThrow();
    }
  });

  it('accepts an absolute http(s) aiPolicy.url, and lets the key be absent', () => {
    for (const url of [
      'https://www.ardc.net/apply/grant-application-instructions/',
      'http://www.arrl.org/ai-policy',
      'https://example.test:8443/policy?x=1#top',
    ]) {
      const program = makeProgram({ aiPolicy: { stance: 'permitted', url } });
      expect(programSchema.parse(program).aiPolicy.url).toBe(url);
    }
    const noUrl = makeProgram({ aiPolicy: { stance: 'unaddressed' } });
    expect(programSchema.parse(noUrl).aiPolicy.url).toBeUndefined();
  });

  it('refuses to store an aiPolicy.url no page can safely render as a link', () => {
    for (const url of [
      'javascript:alert(document.cookie)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      '//www.farweb.org/scholarships',
      '/apply',
      'not a url',
      '',
    ]) {
      const program = makeProgram({ aiPolicy: { stance: 'permitted', url } });
      expect(() => programSchema.parse(program), url).toThrow();
    }
  });

  it('rejects a Constraint whose spec axis is not in the union', () => {
    expect(() => constraintSpecSchema.parse({ axis: 'vibes', note: 'nope' })).toThrow();
  });

  it('accepts every one of the 13 constraint axes', () => {
    const specs = [
      { axis: 'license', licenseMin: 'GENERAL', heldMonthsMin: 12, foreignLicenseOK: false },
      { axis: 'geography', geo: { type: 'state', values: ['LA'] } },
      { axis: 'field_of_study', fields: ['Any'], excludedFields: ['Liberal Arts'] },
      {
        axis: 'institution',
        degreeLevels: ['BACH', 'GRAD'],
        tradeSchoolOK: false,
        partTimeOK: true,
        accreditationRequired: true,
      },
      { axis: 'gpa', min: 3, classRankTopPct: 10 },
      { axis: 'arrl_membership', required: true, minYears: 1 },
      { axis: 'recommendation', recommenderType: 'sponsor_org_member', count: 3 },
      { axis: 'citizenship', allowed: ['US_CITIZEN'], withinMonthsOfCitizenship: 3 },
      { axis: 'age_stage', ageMin: 17, ageMax: 25, asOf: '06-01', stages: ['UNDERGRAD'] },
      {
        axis: 'ham_activity',
        activityKinds: ['club_member', 'field_day'],
        cwProficiencyWpmMin: 15,
        proofRequired: true,
      },
      { axis: 'financial_need', weighted: true },
      { axis: 'gender', allowed: ['female'] },
      { axis: 'other', note: 'preference to a student ham from a ham family' },
    ];
    for (const spec of specs) {
      expect(() => constraintSpecSchema.parse(spec)).not.toThrow();
    }
    expect(specs).toHaveLength(13);
  });

  it('accepts both profile shapes', () => {
    expect(profileSchema.parse(makeStudent()).kind).toBe('student');
    expect(profileSchema.parse(makeOrg()).kind).toBe('organization');
  });

  it('builds constraints with rawText always populated', () => {
    const c = makeConstraint({ axis: 'gpa', min: 2.5 }, { hard: false, fallbackRank: 1 });
    expect(c.rawText.length).toBeGreaterThan(0);
    expect(c.hard).toBe(false);
    expect(c.fallbackRank).toBe(1);
  });
});
