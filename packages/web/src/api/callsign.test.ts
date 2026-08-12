import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * THE HAND-COPIED TYPE, COMPARED WITH THE ONE IT COPIES.
 *
 * `api/callsign.ts` restates `packages/server/src/callsign/types.ts` because the import direction
 * is one-way: web may import from core, never from server. The restatement is the only thing that
 * decides what the browser can SEE, because the route answers with `res.json(result)` and sends
 * the whole record whatever this file happens to declare. So a field added on the server does not
 * break anything here — it simply becomes invisible, which is the worst failure mode a mirror has.
 *
 * IT HAD FAILED THAT WAY TWICE AT ONCE by 2026-08-11. `malformed` — a status added 2026-08-09 with
 * its own panel copy — was absent, and `CallsignLookup.tsx` was carrying a local
 * `| 'malformed'` widening to compensate, which is a mirror's lag written down as a workaround
 * rather than fixed. `mailingGeocode` — the latitude, longitude and grid square on every
 * successful lookup — was absent too, so the profile editor could not read a coordinate the server
 * had already sent it. Nothing compared the two declarations.
 *
 * WHY TEXT AND NOT TYPES. A structural assertion (`const _x: WebRecord = {} as ServerRecord`) is
 * the obvious approach and it cannot be written: importing the server's type into a web test is
 * the exact direction this mirror exists to avoid, and doing it in a test file would make the
 * suite green on an app that cannot build. So the two files are read as TEXT and their
 * declarations compared. That also catches the case a structural check would miss — a field
 * present in both but with a different shape.
 *
 * WHAT IS DELIBERATELY NOT COMPARED: doc comments (stripped) and field ORDER. Everything else about
 * a member — its name, its `?`, and the TYPE TEXT after the colon — is compared, in both
 * directions, because equality is symmetric and a mirror has two ways to go wrong.
 *
 * IT COMPARED ONLY THE NAMES UNTIL 2026-08-11, AND THAT IS THE DEFECT THIS HEADER HAD BEEN
 * CLAIMING TO CATCH. `members()` builds a name→type map and the `CallsignRecord` assertion called
 * `.keys()` on it and threw the types away — so the largest declaration in the file, the one the
 * server actually sends, was checked for the presence of fields and for nothing about them.
 * Measured by breaking it, before the fix, with `npx vitest run packages/web/src/api/callsign.test.ts`
 * after each edit:
 *
 *   web `isPoBox: boolean` → `string`                     NOT CAUGHT
 *   web `type: 'PERSON' | 'CLUB'` → `… | 'MILITARY'`      NOT CAUGHT
 *   web `source: 'callook.info'` → `string`               NOT CAUGHT
 *   web `record?: CallsignRecord` → `record:` (required)  NOT CAUGHT — never compared at all
 *   SERVER `type` widened, web left alone                 NOT CAUGHT
 *
 * The last is the direction that matters, and it is the one the header promised. The technique was
 * already in this file — the `GeocodedPoint` assertion compares `[...members(...)]`, entries and
 * all, and catches every one of those — and was simply not applied to the declaration that needed
 * it. So the entry comparison is now the rule rather than one case's flourish, and
 * `CallsignLookupResult` is compared too.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const SERVER_TYPES = path.join(REPO, 'packages/server/src/callsign/types.ts');
const WEB_TYPES = path.join(HERE, 'callsign.ts');

/** Comments may explain a declaration; they are not part of it. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** The right-hand side of `export type NAME =`, to the `;` that closes it. */
function typeBody(source: string, name: string): string {
  const start = source.indexOf(`export type ${name} =`);
  if (start < 0) throw new Error(`no 'export type ${name}' in this file`);
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{' || ch === '(') depth += 1;
    else if (ch === '}' || ch === ')') depth -= 1;
    else if (ch === ';' && depth === 0) return source.slice(start, i);
  }
  throw new Error(`'export type ${name}' is never terminated`);
}

/** The body of `export interface NAME { … }`, braces balanced. */
function interfaceBody(source: string, name: string): string {
  const header = source.indexOf(`export interface ${name} {`);
  if (header < 0) throw new Error(`no 'export interface ${name}' in this file`);
  const open = source.indexOf('{', header);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`'export interface ${name}' is never closed`);
}

/** Every `'literal'` in a union, in the order written. */
function unionLiterals(body: string): string[] {
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
}

/**
 * Every `{ … }` arm of a union type body, brace-balanced, in the order written.
 *
 * THIS REPLACES TWO HAND-WRITTEN REGEXES THAT DID NOT DO WHAT THIS FILE'S HEADER SAYS IS DONE TO
 * EVERY MEMBER — "its name, its `?`, and the TYPE TEXT after the colon — is compared, in both
 * directions". The `GeocodeRefusal` one read `/(\w+)\??:\s*(\w+)/g`: `\??` MATCHED the optional
 * marker and then discarded it, and `(\w+)` could only ever capture a single-word type. The
 * `MailingGeocode` one read `/geocodedFrom:\s*'([a-z_]+)';\s*(\w+):/g` and captured the KEY alone,
 * never the type after it. Measured by breaking each, on 2026-08-12, with
 * `npx vitest run packages/web/src/api/callsign.test.ts` after each edit:
 *
 *   web `containingLocator: string`  → `containingLocator?: string`      NOT CAUGHT
 *   web `poBox: GeocodedPoint`       → `poBox: { latitude: number; … }`  NOT CAUGHT
 *
 * Both are exactly the drift this file exists to stop, and both are worse than a missing field.
 * An optional `containingLocator` is a browser rendering "the coordinate beside it falls in
 * undefined instead" — measured happening in Chromium the same day. An inlined point is the
 * flattening the `MailingGeocode` assertion's own comment warns about, one step from the shape it
 * says "would compile, would look tidier, and would hand the browser a post office
 * indistinguishable from a street address".
 *
 * So the arms are split structurally and handed to `members()`, which is the same parser the
 * interface assertions use and the one that already compares optionality and full type text. The
 * technique was in the file; it was the two flourishes that were not using it.
 */
function unionArms(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        out.push(body.slice(start + 1, i));
        start = -1;
      }
    }
  }
  return out;
}

/** `name`, `name?` and the type text after the colon, for one level of an object body. */
function members(body: string): Map<string, string> {
  const out = new Map<string, string>();
  let depth = 0;
  let current = '';
  for (const ch of body) {
    if (ch === '{') depth += 1;
    if (ch === '}') depth -= 1;
    if ((ch === ';' || ch === '\n') && depth === 0) {
      const m = /^\s*(\w+)(\??):\s*([\s\S]+?)\s*$/.exec(current);
      if (m !== null) out.set(`${m[1]}${m[2]}`, (m[3] ?? '').replace(/\s+/g, ' ').replace(/[;,]$/, ''));
      current = '';
      continue;
    }
    current += ch;
  }
  const last = /^\s*(\w+)(\??):\s*([\s\S]+?)\s*$/.exec(current);
  if (last !== null) {
    out.set(`${last[1]}${last[2]}`, (last[3] ?? '').replace(/\s+/g, ' ').replace(/[;,]$/, ''));
  }
  return out;
}

const server = stripComments(readFileSync(SERVER_TYPES, 'utf8'));
const web = stripComments(readFileSync(WEB_TYPES, 'utf8'));

describe('the web mirror of the server callsign types', () => {
  it('answers the same six statuses, in the same words', () => {
    const expected = unionLiterals(typeBody(server, 'CallsignLookupStatus'));
    expect(expected).toContain('malformed');
    expect(unionLiterals(typeBody(web, 'CallsignLookupStatus')).sort()).toEqual([...expected].sort());
  });

  /** `[name?, type]` pairs, sorted by name, so field ORDER is free to differ and nothing else is. */
  function sortedMembers(source: string, name: string): Array<[string, string]> {
    return [...members(interfaceBody(source, name))].sort((a, b) => a[0].localeCompare(b[0]));
  }

  it('declares every field of CallsignRecord, with the same optionality AND the same type', () => {
    const expected = sortedMembers(server, 'CallsignRecord');
    const names = expected.map(([name]) => name);
    // Vacuity guard: this assertion is worthless if the parse above found nothing.
    expect(names).toContain('mailingGeocode?');
    expect(names).toContain('geocodeRefusal?');
    expect(names).toContain('isPoBox');
    // And a guard on the half that was missing: the map has to carry types, not just names.
    expect(Object.fromEntries(expected).isPoBox).toBe('boolean');
    expect(sortedMembers(web, 'CallsignRecord')).toEqual(expected);
  });

  it('declares the result envelope the same way, record and message optional in both', () => {
    // Never compared until 2026-08-11, so `record?` becoming required in one copy — which is what
    // decides whether the browser has to check before reading it — was invisible.
    const expected = sortedMembers(server, 'CallsignLookupResult');
    expect(expected).toEqual([
      ['message?', 'string'],
      ['record?', 'CallsignRecord'],
      ['status', 'CallsignLookupStatus'],
    ]);
    expect(sortedMembers(web, 'CallsignLookupResult')).toEqual(expected);
  });

  /**
   * `discriminant { name?: type; … }` for every arm of a union, fields sorted by name.
   *
   * Sorted for the same reason `sortedMembers` sorts: this file compares everything about a member
   * except where it was written. Built on `members()` rather than on a regex of its own, which is
   * the whole correction of 2026-08-12 — see {@link unionArms}.
   */
  function armMembers(source: string, name: string, discriminant: string): string[] {
    return unionArms(typeBody(source, name)).map((arm) => {
      const fields = [...members(arm)].sort((a, b) => a[0].localeCompare(b[0]));
      const tag = fields.find(([field]) => field === discriminant)?.[1] ?? '<no discriminant>';
      return `${tag} { ${fields.map(([field, type]) => `${field}: ${type}`).join('; ')} }`;
    });
  }

  it('states the same reasons for refusing a location, with the same evidence on each', () => {
    // `GeocodeRefusal` is the second shape of the coordinate answer, and it is the one the panel
    // reads to explain an empty box. An arm the browser cannot see is a reason the reader is not
    // given — which is the whole defect that put this type on the wire. An arm whose evidence is
    // OPTIONAL in one copy is a worse version of the same thing: the sentence is built from that
    // evidence, so the browser renders it with a hole where the missing half should be.
    const arms = (source: string): string[] => armMembers(source, 'GeocodeRefusal', 'refused');
    expect(arms(server)).toEqual([
      "'contradicted' { containingLocator: string; gridsquare: string; refused: 'contradicted' }",
      "'unreadable_locator' { because: string; gridsquare: string; refused: 'unreadable_locator' }",
      "'locator_too_coarse' { gridsquare: string; refused: 'locator_too_coarse' }",
      "'placeholder' { refused: 'placeholder' }",
      "'incomplete' { refused: 'incomplete' }",
    ]);
    expect(arms(web)).toEqual(arms(server));
  });

  it('declares the same three things a coordinate can be a geocode of', () => {
    const expected = unionLiterals(typeBody(server, 'GeocodedFrom'));
    expect(expected).toEqual(['street_address', 'po_box', 'address_not_stated']);
    expect(unionLiterals(typeBody(web, 'GeocodedFrom'))).toEqual(expected);
  });

  it('keeps the point under a different key per arm, which is what forces the narrowing', () => {
    // The whole safety property of `MailingGeocode` is that `geocode.poBox` does not typecheck
    // until the consumer has narrowed to the arm that has one. A mirror that flattened the three
    // arms into `{ geocodedFrom, point }` would compile, would look tidier, and would hand the
    // browser a post office indistinguishable from a street address.
    //
    // AND THE TYPE UNDER THE KEY IS COMPARED TOO, SINCE 2026-08-12. The regex here captured
    // `geocodedFrom -> key` and stopped at the colon, so `poBox: GeocodedPoint` rewritten as an
    // inline `{ latitude: number; longitude: number; gridsquare: string }` passed — a copy that had
    // stopped mirroring `GeocodedPoint` at all, which is one edit away from the flattening
    // described above and reads as a deliberate difference to nobody.
    const arms = (source: string): string[] =>
      armMembers(source, 'MailingGeocode', 'geocodedFrom');
    expect(arms(server)).toEqual([
      "'street_address' { geocodedFrom: 'street_address'; mailingAddress: GeocodedPoint }",
      "'po_box' { geocodedFrom: 'po_box'; poBox: GeocodedPoint }",
      "'address_not_stated' { geocodedFrom: 'address_not_stated'; unattributed: GeocodedPoint }",
    ]);
    expect(arms(web)).toEqual(arms(server));
  });

  it('states a point with the same three parts and the same types', () => {
    const expected = members(interfaceBody(server, 'GeocodedPoint'));
    expect([...expected]).toEqual([
      ['latitude', 'number'],
      ['longitude', 'number'],
      ['gridsquare', 'string'],
    ]);
    expect([...members(interfaceBody(web, 'GeocodedPoint'))]).toEqual([...expected]);
  });

  it('reads the server file it claims to mirror, and not an empty string', () => {
    // The three parsers above throw on a missing declaration, but a silently EMPTY file would make
    // every `toEqual([])` pass. This is the guard on the guard.
    expect(server.length).toBeGreaterThan(1000);
    expect(server).toContain('export interface CallsignRecord');
  });
});
