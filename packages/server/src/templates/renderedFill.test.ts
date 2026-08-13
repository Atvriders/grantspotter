/**
 * THE DRAFT AS A STUDENT RECEIVES IT, PINNED IN A UNIT TEST.
 *
 * On 2026-08-13 `e2e/writing.spec.ts:735` went red on the ONE line that reads the draft body —
 * `expect(body).toHaveValue(/\[TODO: club\.callsign — /)` — while `npm test` was fully green
 * (225 files, 6,004 passed) and `npm run typecheck` and `npm run build` were clean. Six thousand
 * unit tests and not one of them could answer the question the browser had just asked: WHAT TEXT
 * DOES `need-statement` PUT ON THE SCREEN? Every test around it asserted a fragment — that
 * `todoFor` names its slot, that `fillTemplate` leaves `unresolvedSlots` behind, that
 * `buildSlotContext` projects the known half — and a rendered document is not the conjunction of
 * its fragments. So the suspicion fell on `shippedText.ts`, three commits back, and the only way
 * to clear it was to reconstruct the route's own call chain by hand in a scratch script.
 *
 * That reconstruction is this file, and it is the whole point of it. These two tests run the
 * EXACT chain `POST /api/templates/:id/fill` runs — `getTemplate` -> `buildSlotContext` ->
 * `fillTemplate`, off the shipped `content/` directory, no fixture — and assert the bytes. If any
 * change anywhere in the graph moves a single character of what a student is handed, this fails
 * in `npm test`, before a browser is ever opened.
 *
 * THE `club.callsign` MARKER IS ASSERTED WHOLE, hint and em dash included, and not by the shape
 * `/\[TODO: [a-z.]+\]/`. A marker that lost its hint would still be a marker, still be counted
 * once by the export gate, and still satisfy every loose assertion in `fill.test.ts` — and the
 * student would be looking at `[TODO: club.callsign]` with no idea that what belongs in the hole
 * is their club's FCC callsign. The failure this whole subsystem exists to prevent is a SILENT
 * gap, and a gap that no longer says what it wants is most of the way to silent.
 */
import { describe, expect, it } from 'vitest';
import { fillTemplate } from './fill.js';
import { getTemplate } from './load.js';
import { buildSlotContext } from './slots.js';

/**
 * `api/templates.ts`'s handler, minus Express. It passes no profile, no program and no funder,
 * which is the state a student is in the first time they press "Insert a section" — the state in
 * which EVERY slot must come back as a visible hole.
 */
function fillAsTheRouteDoes(id: string): { markdown: string; unresolvedSlots: string[] } {
  const template = getTemplate(id);
  const ctx = buildSlotContext({
    profile: undefined,
    program: undefined,
    funder: undefined,
    answers: {},
  });
  return fillTemplate(template.body, ctx);
}

describe('the filled need-statement, exactly as the writing desk renders it', () => {
  it('opens every slot as a named [TODO: …] gap and leaves no raw {{slot}} behind', () => {
    const filled = fillAsTheRouteDoes('need-statement');

    // The browser assertion, in a unit test. `toHaveValue(/\[TODO: club\.callsign — /)` is what
    // went red; this is the same claim about the same string, one layer down.
    expect(filled.markdown).toContain("[TODO: club.callsign — your club's FCC callsign, e.g. W8UM]");
    expect(filled.markdown).not.toContain('{{');

    // Every hole in the skeleton, in the order the sentence reaches them. A slot that quietly
    // stopped being a slot — or a template edit that dropped one of these sentences — changes
    // this list, and the student loses a prompt they were relying on.
    expect(filled.unresolvedSlots).toEqual([
      'club.name',
      'club.callsign',
      'club.arrlAffiliated',
      'project.venue',
      'club.institution',
      'club.city',
      'club.state',
      'club.memberCount',
      'project.problem',
      'project.beneficiaryCount',
    ]);

    // Every unresolved slot reached the body as its own marker: the count of `[TODO:` openings
    // equals the count of holes reported. A slot dropped from the text but still reported here —
    // or reported here but rendered as nothing — is the silent gap, and this is the arithmetic
    // that catches it without naming ten more literals.
    const markers = filled.markdown.match(/\[TODO: /g) ?? [];
    expect(markers.length).toBe(filled.unresolvedSlots.length);
    for (const slot of filled.unresolvedSlots) {
      expect(filled.markdown, `${slot} reported unresolved but has no marker naming it`).toContain(
        `[TODO: ${slot} — `,
      );
    }
  });

  it('renders the skeleton sentence verbatim, gaps and prose together', () => {
    const filled = fillAsTheRouteDoes('need-statement');

    // The one line of the template that is nothing BUT slots and connective tissue, whole. This
    // is the sentence a reviewer reads first, and every word between the brackets is the
    // product's own — so this pins the fill and the shipped copy against each other in one line.
    expect(filled.markdown).toContain(
      '[TODO: club.name — the full legal or published name of the applying club] ' +
        "([TODO: club.callsign — your club's FCC callsign, e.g. W8UM]) is " +
        '[TODO: club.arrlAffiliated — whether the club is an ARRL-affiliated club] operating from ' +
        '[TODO: project.venue — the building and room, e.g. Room 214, Engineering Building] at ' +
        '[TODO: club.institution — the school or university that hosts the club] in ' +
        '[TODO: club.city — the city the club operates from, e.g. Ann Arbor], ' +
        '[TODO: club.state — two-letter state code, e.g. MI], with ' +
        '[TODO: club.memberCount — a headcount you can defend if asked, e.g. 34] members.',
    );
  });
});
