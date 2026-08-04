import type { StudentProfile } from '@grantspotter/core';
import { describe, expect, it } from 'vitest';
import {
  TODO_MARKER_SCAN,
  extractSlots,
  fillTemplate,
  renderSlotValue,
  stripTodoMarkers,
  todoFor,
} from './fill.js';
import { deriveSlots } from './load.js';
import { SLOT_VOCABULARY, buildSlotContext, describeSlotKnowledge } from './slots.js';

/**
 * The regex Task 14's `exportReadiness` uses to count open gaps:
 *   const openTodos = [...text.matchAll(/\[TODO:[^\]]*\]/g)].length;
 * It is transcribed here, deliberately, so that a change to the marker format in `fill.ts` fails
 * HERE rather than silently letting a draft with holes in it pass the export gate.
 */
const EXPORT_GATE_SCAN = (): RegExp => /\[TODO:[^\]]*\]/g;

/** Anything a reviewer could read as a callsign: one or two letters, digits, one to four letters. */
const CALLSIGN_SHAPED = /\b[A-Z]{1,2}\d{1,2}[A-Z]{1,4}\b/;

describe('fillTemplate', () => {
  it('substitutes known values and tolerates whitespace inside the braces', () => {
    const out = fillTemplate('{{club.name}} ({{ club.callsign }}) meets weekly.', {
      'club.name': 'Example Collegiate Amateur Radio Club',
      'club.callsign': 'W8UM',
    });
    expect(out.markdown).toBe('Example Collegiate Amateur Radio Club (W8UM) meets weekly.');
    expect(out.unresolvedSlots).toEqual([]);
  });

  it('resolves nested context objects as well as flat dotted keys', () => {
    const out = fillTemplate('{{club.callsign}}', { club: { callsign: 'K5UTD' } });
    expect(out.markdown).toBe('K5UTD');
  });

  it('renders an explicit TODO with the slot hint when a value is missing', () => {
    const out = fillTemplate('Our club {{club.callsign}} will teach.', {});
    expect(out.markdown).toBe(
      "Our club [TODO: club.callsign — your club's FCC callsign, e.g. W8UM] will teach.",
    );
    expect(out.unresolvedSlots).toEqual(['club.callsign']);
  });

  it('NEVER emits plausible filler for a missing callsign', () => {
    const out = fillTemplate('{{club.callsign}} and {{student.callsign}}', {});
    // The hints deliberately carry an EXAMPLE callsign, so the assertion that matters is about the
    // text OUTSIDE the markers: nothing a reviewer could mistake for this applicant's own callsign
    // may survive once the visible gaps are removed. (The brief asserted this against the whole
    // output, which its own hint text — "e.g. W8UM" — cannot satisfy. See task-3-report.md.)
    expect(stripTodoMarkers(out.markdown)).not.toMatch(CALLSIGN_SHAPED);
    expect(out.markdown).toContain('[TODO: club.callsign');
    expect(out.markdown).toContain('[TODO: student.callsign');
  });

  it('treats empty strings, whitespace, null, undefined, empty arrays and objects as missing', () => {
    const ctx = {
      'club.name': '',
      'club.city': '   ',
      'club.state': null,
      'club.ein': undefined,
      'project.equipment': [],
      'project.summary': { nested: 'value' },
    };
    const tpl =
      '{{club.name}}|{{club.city}}|{{club.state}}|{{club.ein}}|{{project.equipment}}|{{project.summary}}';
    const out = fillTemplate(tpl, ctx);
    expect(out.unresolvedSlots).toEqual([
      'club.name',
      'club.city',
      'club.state',
      'club.ein',
      'project.equipment',
      'project.summary',
    ]);
    expect(out.markdown.split('|').every((part) => part.startsWith('[TODO: '))).toBe(true);
  });

  it('reports each unresolved slot once, in first-appearance order, but marks every occurrence', () => {
    const out = fillTemplate('{{club.name}} {{club.callsign}} {{club.name}}', {});
    expect(out.unresolvedSlots).toEqual(['club.name', 'club.callsign']);
    // Three slots stood in the body, so three gaps stand in the output. Deduping the REPORT must
    // never dedupe the DOCUMENT: a second sentence left with no marker is a sentence with a hole.
    expect([...out.markdown.matchAll(EXPORT_GATE_SCAN())]).toHaveLength(3);
  });

  it('renders numbers verbatim, booleans as yes/no, and arrays comma-joined', () => {
    expect(renderSlotValue(34)).toBe('34');
    expect(renderSlotValue(3.4)).toBe('3.4');
    expect(renderSlotValue(true)).toBe('yes');
    expect(renderSlotValue(false)).toBe('no');
    expect(renderSlotValue(['one Icom IC-7300', 'two Comet GP-3 antennas'])).toBe(
      'one Icom IC-7300, two Comet GP-3 antennas',
    );
    expect(renderSlotValue(Number.NaN)).toBeUndefined();
  });

  it('keeps zero and false, which are real answers, out of the missing bucket', () => {
    const out = fillTemplate('Indirect: {{project.indirectPct}}%. Affiliated: {{club.arrlAffiliated}}.', {
      'project.indirectPct': 0,
      'club.arrlAffiliated': false,
    });
    expect(out.markdown).toBe('Indirect: 0%. Affiliated: no.');
    expect(out.unresolvedSlots).toEqual([]);
  });

  it('refuses to render an object, a Date or a function as prose', () => {
    // A Date would stringify to "Fri Jan 15 2027 00:00:00 GMT-0500 (…)" inside a grant application,
    // and a function to its own source text. Both are gaps, not facts.
    expect(renderSlotValue(new Date('2027-01-15T00:00:00Z'))).toBeUndefined();
    expect(renderSlotValue(() => 'W1AW')).toBeUndefined();
    expect(renderSlotValue(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(renderSlotValue(Symbol('W1AW'))).toBeUndefined();
  });

  it('drops missing entries from an array instead of rendering a hole inside a list', () => {
    expect(renderSlotValue(['one Icom IC-7610', '', null, 'two DR-2X repeaters'])).toBe(
      'one Icom IC-7610, two DR-2X repeaters',
    );
    expect(renderSlotValue([null, '  '])).toBeUndefined();
  });

  it('does not re-expand slot syntax that arrives inside a substituted value', () => {
    const out = fillTemplate('{{project.title}}', { 'project.title': '{{club.callsign}} station rebuild' });
    expect(out.markdown).toBe('{{club.callsign}} station rebuild');
    expect(out.unresolvedSlots).toEqual([]);
  });

  it('inserts a value containing $& or $1 literally, never as a replacement pattern', () => {
    const out = fillTemplate('{{project.title}}', { 'project.title': "Rebuild $& for $1 and $' each" });
    expect(out.markdown).toBe("Rebuild $& for $1 and $' each");
  });

  it('never reaches through the prototype chain for a value', () => {
    // `{{toString}}` must not render "function toString() { [native code] }", and a slot that
    // names an inherited property must be a gap like any other unknown.
    const out = fillTemplate('{{toString}} {{club.constructor}}', { club: { callsign: 'W8UM' } });
    expect(out.markdown).toBe('[TODO: toString] [TODO: club.constructor]');
    expect(out.unresolvedSlots).toEqual(['toString', 'club.constructor']);
  });

  it('falls back to a bare TODO for a slot outside the vocabulary', () => {
    expect(todoFor('made.upSlot')).toBe('[TODO: made.upSlot]');
  });

  it('never lets an inherited property or a blank hint become the text of a gap', () => {
    // A vocabulary backed by a plain object instead of a Map answers `slotDef('toString')` with
    // `Object.prototype.toString`, and the marker becomes
    // "[TODO: toString — function toString() { [native code] }]" inside a grant application.
    expect(todoFor('toString')).toBe('[TODO: toString]');
    expect(todoFor('constructor')).toBe('[TODO: constructor]');
    expect(todoFor('club.name', '   ')).toBe('[TODO: club.name]');
  });

  it('extractSlots lists every distinct slot in first-appearance order', () => {
    expect(extractSlots('{{b.one}} {{a.two}} {{b.one}}')).toEqual(['b.one', 'a.two']);
  });

  it('extractSlots agrees with the loader deriveSlots that decides a template documented slots', () => {
    // Two modules scan for `{{ … }}` with their own copy of the same regex. If they ever drift, a
    // template would advertise slots it does not fill, or fill slots it never advertised.
    const body = [
      '# {{ project.title }}',
      '',
      'Our club {{club.callsign}} at {{club.institution}} requests {{project.requestAmount}}.',
      'Repeated: {{club.callsign}}. Newline inside braces: {{',
      '  club.name',
      '}}. Not a slot: {{ 9lives }} {{}} {{ a b }}.',
    ].join('\n');
    expect(extractSlots(body)).toEqual(deriveSlots(body));
    expect(extractSlots(body)).toEqual([
      'project.title',
      'club.callsign',
      'club.institution',
      'project.requestAmount',
      'club.name',
    ]);
  });
});

describe('a gap is a gap after copy-paste', () => {
  it('leaves a visible marker where a sentence would otherwise quietly assert nothing', () => {
    const tpl =
      'Our club, {{club.name}} ({{club.callsign}}), was founded in {{club.foundedYear}} and has {{club.memberCount}} licensed members who meet in {{project.venue}}.';
    const out = fillTemplate(tpl, {});

    // What a naive "just substitute the empty string" implementation would have produced: a
    // sentence that still SCANS, carries no marker, and asserts nothing a human can act on.
    expect(stripTodoMarkers(out.markdown)).toBe(
      'Our club,  (), was founded in  and has  licensed members who meet in .',
    );

    // What this implementation produces instead: five gaps, each naming the fact it wants.
    expect(out.unresolvedSlots).toEqual([
      'club.name',
      'club.callsign',
      'club.foundedYear',
      'club.memberCount',
      'project.venue',
    ]);
    for (const path of out.unresolvedSlots) expect(out.markdown).toContain(`[TODO: ${path} —`);

    // No figure and no callsign-shaped token survives outside the markers, so there is nothing in
    // the prose a reviewer could read as a fact about this applicant.
    expect(stripTodoMarkers(out.markdown)).not.toMatch(/\d/);
    expect(stripTodoMarkers(out.markdown)).not.toMatch(CALLSIGN_SHAPED);
  });

  it('emits markers the export gate counts, one per unfilled occurrence', () => {
    const out = fillTemplate('{{club.name}} and {{project.venue}} and {{club.name}}', {});
    expect([...out.markdown.matchAll(EXPORT_GATE_SCAN())]).toHaveLength(3);
  });

  it('every marker in the vocabulary is plain, visible text that survives a word processor', () => {
    for (const slot of [...SLOT_VOCABULARY.map((s) => s.path), 'made.upSlot']) {
      const marker = todoFor(slot);

      // Counted exactly once by Task 14's gate: no `]` inside the marker may end it early.
      const gateHits = [...marker.matchAll(EXPORT_GATE_SCAN())];
      expect(gateHits).toHaveLength(1);
      expect(gateHits[0]?.[0]).toBe(marker);

      // Names the fact that belongs there.
      expect(marker.startsWith(`[TODO: ${slot}`)).toBe(true);

      // A marker always contains a space, which is what stops CommonMark parsing `[text]({{slot}})`
      // -> `[text]([TODO: … ])` as a link: a link destination may not contain spaces unless it is
      // wrapped in <>. The gap therefore renders as literal visible text rather than vanishing
      // into a hyperlink target.
      expect(marker).toContain(' ');

      // Nothing here can hide: no HTML comment, no tag, no zero-width or bidi character.
      expect(marker).not.toMatch(/[<>]/);
      expect(marker).not.toMatch(/[\u00ad\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\ufeff]/);
      expect(marker.trim()).toBe(marker);
    }
  });

  it('stripTodoMarkers removes only markers, so the prose analyzer cannot score an example as a fact', () => {
    // Task 12 flags a paragraph with zero proper nouns and zero figures. "e.g. W8UM" inside a gap
    // is not a proper noun the applicant supplied, and must not earn the paragraph a passing score.
    const out = fillTemplate('{{club.callsign}} operates from Ann Arbor.', {});
    expect(out.markdown).toContain('W8UM');
    expect(stripTodoMarkers(out.markdown)).toBe(' operates from Ann Arbor.');
    expect(stripTodoMarkers('nothing to strip')).toBe('nothing to strip');
  });

  it('TODO_MARKER_SCAN hands out a fresh regex, so a shared lastIndex cannot skip a gap', () => {
    const text = todoFor('club.name') + todoFor('club.callsign');
    expect([...text.matchAll(TODO_MARKER_SCAN())]).toHaveLength(2);
    expect([...text.matchAll(TODO_MARKER_SCAN())]).toHaveLength(2);
  });
});

describe('the three states of Task 2 knowledge, through fillTemplate', () => {
  const STUDENT: StudentProfile = {
    kind: 'student',
    callsign: 'KD9XYZ',
    licenseClass: 'GENERAL',
    licensedSince: '2023-04-11',
    institution: 'Example State University',
    degreeLevel: 'BACH',
    fieldOfStudy: 'Electrical Engineering',
    gpa: 3.4,
    state: 'MI',
  };

  it('leaves a not_applicable slot as a visible gap, exactly like an unknown one', () => {
    // `describeSlotKnowledge` draws three states; `buildSlotContext` is its `known` projection, so
    // BOTH `unknown` and `not_applicable` reach fillTemplate as an absent key. That is the safe
    // direction and it is pinned here: a template that uses a slot the applicant cannot answer must
    // still show a hole. A club member count for an individual applicant is the case Task 2 names.
    const knowledge = describeSlotKnowledge({ profile: STUDENT });
    expect(knowledge['club.memberCount']?.state).toBe('not_applicable');
    expect(knowledge['project.venue']?.state).toBe('unknown');
    expect(knowledge['student.callsign']).toEqual({ state: 'known', value: 'KD9XYZ', origin: 'profile' });

    const ctx = buildSlotContext({ profile: STUDENT });
    expect('club.memberCount' in ctx).toBe(false);

    const out = fillTemplate(
      '{{student.callsign}} of a club with {{club.memberCount}} members meeting in {{project.venue}}.',
      ctx,
    );
    expect(out.markdown).toBe(
      'KD9XYZ of a club with [TODO: club.memberCount — a headcount you can defend if asked, e.g. 34] members meeting in [TODO: project.venue — the building and room, e.g. Room 214, Engineering Building].',
    );
    expect([...out.markdown.matchAll(EXPORT_GATE_SCAN())]).toHaveLength(2);
    expect(out.unresolvedSlots).toEqual(['club.memberCount', 'project.venue']);
  });

  it('agrees with slots.ts on what counts as a value, in both directions', () => {
    // slots.ts documents this obligation in `present()`: if the two layers ever disagree, a value
    // enters the context there and renders as a [TODO: …] here — a slot the fact checklist believes
    // is answered and the document shows as a hole, or worse, the reverse.
    const ctx = buildSlotContext({
      profile: STUDENT,
      answers: { 'project.title': 'Campus Beacon Rebuild', 'project.venue': '   ', 'club.city': '' },
    });
    for (const [path, value] of Object.entries(ctx)) {
      expect(renderSlotValue(value), `context carried ${path} but fill would not render it`).not.toBe(
        undefined,
      );
    }
    const knowledge = describeSlotKnowledge({ profile: STUDENT });
    // Vacuity guard: the loop below only bites on `known` entries, so there must be some.
    expect(Object.values(knowledge).filter((k) => k.state === 'known').length).toBeGreaterThan(5);
    expect(Object.keys(ctx).length).toBeGreaterThan(5);
    for (const [path, k] of Object.entries(knowledge)) {
      const renderable = k.state === 'known' && renderSlotValue(k.value) !== undefined;
      expect(renderable, `${path}: knowledge state and renderability disagree`).toBe(
        k.state === 'known',
      );
    }
    expect(ctx['project.title']).toBe('Campus Beacon Rebuild');
    expect('project.venue' in ctx).toBe(false);
    expect('club.city' in ctx).toBe(false);
  });
});
