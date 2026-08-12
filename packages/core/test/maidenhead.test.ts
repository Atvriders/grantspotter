import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// The only import here from outside the module under test. `maidenhead.ts` does not depend on
// `geo.ts` on purpose — see its header — but the header quotes distances, and a distance needs an
// Earth model. This is where the two meet, so that a mileage in a comment cannot drift again.
import { haversineMiles } from '../src/geo.js';
import {
  boxContainsCoordinate,
  boxRepresentativePoint,
  canonicalMaidenhead,
  checkCoordinateAgainstLocator,
  coordinateToLocator,
  MAIDENHEAD_PRECISIONS,
  MAIDENHEAD_SPAN_DEG,
  maidenheadBox,
  maidenheadRepresentativePoint,
  parseMaidenhead,
  wrapLongitudeDeg,
  type MaidenheadPrecision,
} from '../src/maidenhead.js';

/**
 * WHY THIS FILE IS IN `test/` AND NOT `src/`, THOUGH THE BRIEF ASKED FOR `src/maidenhead.test.ts`.
 *
 * Both were measured, with a throwaway probe file, before this was written:
 *
 *   1. `packages/core/vitest.config.ts` includes `test/**\/*.test.ts` and nothing else, so a test
 *      under `src/` IS NEVER RUN. `packages/server/test/vitestCoverageContract.test.ts` exists to
 *      catch exactly that and it does — the probe turned it red, naming the file. Its own comment
 *      lists this as known defect 3: "packages/core — a src/*.test.ts would never run".
 *   2. `packages/core/test/purity.test.ts` walks every `.ts` under `src/` and fails on any import
 *      that is not relative or `zod`. A test file there imports `vitest`, so the probe turned that
 *      red too.
 *
 * Fixing either would mean editing a file outside this agent's territory (core's vitest config,
 * or the purity walk) that another agent may be holding. Putting the test where the package
 * already keeps its tests costs nothing and breaks nothing.
 */

const FIXTURES = fileURLToPath(new URL('../../../fixtures/callook/', import.meta.url));

interface CallookCapture {
  readonly current?: { readonly callsign?: string };
  readonly location?: {
    readonly latitude?: string;
    readonly longitude?: string;
    readonly gridsquare?: string;
  };
}

/**
 * Read the committed capture rather than transcribe it. These three files are real HTTP 200
 * responses taken by hand on 2026-08-04 (see `fixtures/callook/README.md`), and they are the only
 * independent check in this file: every other expectation below is arithmetic this module also
 * performs, so it could agree with a bug. callook geocoded these stations and stated a grid
 * square separately, and W1AW's is ARRL headquarters at 225 Main St, Newington.
 */
function capture(file: string): { callsign: string; lat: number; lon: number; grid: string } {
  const raw = JSON.parse(readFileSync(FIXTURES + file, 'utf8')) as CallookCapture;
  const location = raw.location;
  if (location?.latitude === undefined || location.longitude === undefined) {
    throw new Error(`${file} has no location; this test's premise is gone`);
  }
  if (location.gridsquare === undefined) throw new Error(`${file} has no gridsquare`);
  return {
    callsign: raw.current?.callsign ?? file,
    lat: Number(location.latitude),
    lon: Number(location.longitude),
    grid: location.gridsquare,
  };
}

const W1AW = capture('00-callook-info-w1aw-json.json');
const W1MX = capture('01-callook-info-w1mx-json.json');
const K2CC = capture('02-callook-info-k2cc-json.json');
const PERSON_EXTRA = capture('person-extra.json');

describe('the fixtures are what this file thinks they are', () => {
  // A guard against a silently-emptied fixture turning every assertion below vacuous.
  it('carries three real captures with coordinates and grid squares', () => {
    expect([W1AW.callsign, W1MX.callsign, K2CC.callsign]).toEqual(['W1AW', 'W1MX', 'K2CC']);
    expect([W1AW.grid, W1MX.grid, K2CC.grid]).toEqual(['FN31pr', 'FN42li', 'FN24mp']);
    for (const station of [W1AW, W1MX, K2CC]) {
      expect(Number.isFinite(station.lat)).toBe(true);
      expect(Number.isFinite(station.lon)).toBe(true);
    }
  });
});

/**
 * THE FIGURES IN THIS MODULE'S HEADER, CHECKED AGAINST THE ARITHMETIC THEY DESCRIBE.
 *
 * Until 2026-08-11 that header said `FN31pr` is "about 2.9 by 3.5 miles at Newington's latitude".
 * The width was wrong by 23%, and it was wrong in the module that DEFINES what a locator means
 * while its two consumers each had it right — nothing compared them, because a comment is not
 * executable. These assertions make the numbers executable. `haversineMiles` lives in `geo.ts`,
 * which `maidenhead.ts` deliberately does not import; a test may, and that is the point of putting
 * the check here rather than a helper there.
 */
describe('the mileage quoted in the header', () => {
  it('is 2.88 by 4.30 for FN31pr at Newington, not 3.5 across', () => {
    const box = maidenheadBox(W1AW.grid);
    expect(box).toBeDefined();
    if (box === undefined) return;

    const northSouth = haversineMiles(box.south, box.west, box.north, box.west);
    const eastWest = haversineMiles(W1AW.lat, box.west, W1AW.lat, box.east);
    expect(northSouth).toBeCloseTo(2.88, 2);
    expect(eastWest).toBeCloseTo(4.3, 2);
    // The figure that was there before is not merely imprecise, it is outside the box.
    expect(eastWest).toBeGreaterThan(3.6);
  });

  it('is 2.88 by 4.26 for FN42li at Boston, which is why a pair needs a latitude', () => {
    const box = maidenheadBox(W1MX.grid);
    if (box === undefined) throw new Error('FN42li does not parse');

    expect(haversineMiles(box.south, box.west, box.north, box.west)).toBeCloseTo(2.88, 2);
    expect(haversineMiles(W1MX.lat, box.west, W1MX.lat, box.east)).toBeCloseTo(4.26, 2);
  });

  /**
   * The reason the header quotes arcminutes first and states a latitude with every mileage: one of
   * the two numbers is a constant and the other is a function of where you are standing.
   */
  it('changes east-west with latitude and never changes north-south', () => {
    const widths: number[] = [];
    const heights: number[] = [];
    for (const lat of [0, 30, 41.714707, 60, 80]) {
      const locator = coordinateToLocator(lat, -72.7, 6);
      if (locator === undefined) throw new Error(`no locator at ${lat}`);
      const box = maidenheadBox(locator);
      if (box === undefined) throw new Error(`${locator} does not parse`);
      widths.push(haversineMiles(lat, box.west, lat, box.east));
      heights.push(haversineMiles(box.south, box.west, box.north, box.west));
    }
    for (const height of heights) expect(height).toBeCloseTo(heights[0], 9);
    // The equator's box is more than five times the width of the one at 80 degrees north.
    expect(widths[0] / widths[widths.length - 1]).toBeGreaterThan(5);
  });

  /**
   * The other arithmetic the header states outright. It claimed `FN31pr`'s north edge was
   * `(43190 + 10) / 240 - 90 = exactly 41.75`; 43190 is the topmost SUBSQUARE row's south edge, and
   * that expression is 90. FN31pr's is 31610.
   */
  it('puts FN31pr at 31610 units and the topmost subsquare row at 43190', () => {
    const box = maidenheadBox('FN31pr');
    if (box === undefined) throw new Error('FN31pr does not parse');
    expect(Math.round((box.south + 90) * 240)).toBe(31610);
    expect((31610 + 10) / 240 - 90).toBe(41.75);
    expect(box.north).toBe(41.75);

    // The northernmost 6-character row: latitude field R, square 9, subsquare x.
    const top = maidenheadBox('AR09ax');
    if (top === undefined) throw new Error('AR09ax does not parse');
    expect(Math.round((top.south + 90) * 240)).toBe(43190);
    expect((43190 + 10) / 240 - 90).toBe(90);
    expect(top.north).toBe(90);
  });

  /** The `FN` field in the `MaidenheadRepresentativePoint` note: 691 by 1029 at Newington. */
  it('makes a two-character field 691 by 1029 miles at Newington', () => {
    const box = maidenheadBox('FN');
    if (box === undefined) throw new Error('FN does not parse');
    expect([box.south, box.north, box.west, box.east]).toEqual([40, 50, -80, -60]);
    expect(haversineMiles(box.south, box.west, box.north, box.west)).toBeCloseTo(691, 0);
    expect(haversineMiles(W1AW.lat, box.west, W1AW.lat, box.east)).toBeCloseTo(1029, 0);
  });
});

describe('locators whose coordinates are independently known', () => {
  it('puts W1AW inside FN31pr, the box callook stated for it', () => {
    const box = maidenheadBox(W1AW.grid);
    expect(box).toBeDefined();
    if (box === undefined) return;
    // Newington, CT. Hand-checkable: F is longitude field 5 (-180 + 5*20 = -80), N is latitude
    // field 13 (-90 + 13*10 = 40), then 3 -> -74, 1 -> 41, p (index 15) -> -72.75, r (17) -> 41.7083.
    expect(box.south).toBeCloseTo(41.708333, 6);
    expect(box.north).toBe(41.75);
    expect(box.west).toBe(-72.75);
    expect(box.east).toBeCloseTo(-72.666667, 6);
    expect(boxContainsCoordinate(box, W1AW.lat, W1AW.lon)).toBe(true);
    expect(checkCoordinateAgainstLocator(W1AW.lat, W1AW.lon, W1AW.grid).status).toBe('inside');
  });

  it('puts W1MX inside FN42li and K2CC inside FN24mp', () => {
    for (const station of [W1MX, K2CC]) {
      const agreement = checkCoordinateAgainstLocator(station.lat, station.lon, station.grid);
      expect({ callsign: station.callsign, status: agreement.status }).toEqual({
        callsign: station.callsign,
        status: 'inside',
      });
    }
  });

  it('re-derives each station grid square from its own stated coordinate', () => {
    // The strongest form of the fixture check: not "is the coordinate in the box" but "does the
    // arithmetic produce the same six characters callook did", three times, independently.
    for (const station of [W1AW, W1MX, K2CC]) {
      expect(coordinateToLocator(station.lat, station.lon, 6)).toBe(station.grid);
    }
  });

  it('agrees with the hand-built fixture that puts a station at 0, 0 in JJ00aa', () => {
    expect(PERSON_EXTRA.lat).toBe(0);
    expect(PERSON_EXTRA.lon).toBe(0);
    expect(coordinateToLocator(0, 0, 6)).toBe(PERSON_EXTRA.grid);
    const box = maidenheadBox(PERSON_EXTRA.grid);
    expect(box).toEqual(
      expect.objectContaining({ south: 0, west: 0, locator: 'JJ00aa', precision: 6 }),
    );
  });

  it('truncates to a coarser box that still contains the same station', () => {
    // FN31pr, FN31 and FN all name W1AW's location at different confidences, and each box must
    // contain the finer one's coordinate.
    for (const locator of ['FN', 'FN31', 'FN31pr']) {
      const box = maidenheadBox(locator);
      expect(box).toBeDefined();
      if (box === undefined) return;
      expect(boxContainsCoordinate(box, W1AW.lat, W1AW.lon)).toBe(true);
    }
    expect(coordinateToLocator(W1AW.lat, W1AW.lon, 2)).toBe('FN');
    expect(coordinateToLocator(W1AW.lat, W1AW.lon, 4)).toBe('FN31');
    // Hand-checked: W1AW is 0.006374 degrees north of FN31pr's south edge, which is cell 1 of 10
    // at 1/240 degree each, and 0.021589 east of its west edge, which is cell 2 of 10 at 1/120.
    expect(coordinateToLocator(W1AW.lat, W1AW.lon, 8)).toBe('FN31pr21');
  });
});

describe('a locator names a box, and the box is the size the standard says', () => {
  it('reports the documented span at each precision', () => {
    const cases: Array<[string, MaidenheadPrecision, number, number]> = [
      // field pair: 10 degrees by 20
      ['FN', 2, 10, 20],
      // square: 1 by 2
      ['FN31', 4, 1, 2],
      // subsquare: 2.5 arcminutes by 5
      ['FN31pr', 6, 2.5 / 60, 5 / 60],
      // extended square: 0.25 arcminutes by 0.5
      ['FN31pr43', 8, 0.25 / 60, 0.5 / 60],
    ];
    for (const [locator, precision, latSpan, lonSpan] of cases) {
      const box = maidenheadBox(locator);
      expect(box?.precision).toBe(precision);
      expect(box?.latSpanDeg).toBeCloseTo(latSpan, 12);
      expect(box?.lonSpanDeg).toBeCloseTo(lonSpan, 12);
      expect((box?.north ?? 0) - (box?.south ?? 0)).toBeCloseTo(latSpan, 12);
      expect((box?.east ?? 0) - (box?.west ?? 0)).toBeCloseTo(lonSpan, 12);
      expect(MAIDENHEAD_SPAN_DEG[precision].latSpanDeg).toBeCloseTo(latSpan, 12);
      expect(MAIDENHEAD_SPAN_DEG[precision].lonSpanDeg).toBeCloseTo(lonSpan, 12);
    }
  });

  it('tiles the world: the boxes of one precision cover it with no gap and no overlap', () => {
    // Walk the 18 longitude fields and 18 latitude fields and check each box starts where the
    // previous ended. A parser that got a range wrong (A-X in the first pair, say) fails here.
    const lonEdges: number[] = [];
    const latEdges: number[] = [];
    for (let i = 0; i < 18; i += 1) {
      const letter = String.fromCharCode(65 + i);
      const lonBox = maidenheadBox(`${letter}A`);
      const latBox = maidenheadBox(`A${letter}`);
      expect(lonBox).toBeDefined();
      expect(latBox).toBeDefined();
      if (lonBox === undefined || latBox === undefined) return;
      lonEdges.push(lonBox.west, lonBox.east);
      latEdges.push(latBox.south, latBox.north);
    }
    expect(lonEdges[0]).toBe(-180);
    expect(lonEdges[lonEdges.length - 1]).toBe(180);
    expect(latEdges[0]).toBe(-90);
    expect(latEdges[latEdges.length - 1]).toBe(90);
    for (let i = 1; i < 18; i += 1) {
      expect(lonEdges[i * 2]).toBe(lonEdges[i * 2 - 1]);
      expect(latEdges[i * 2]).toBe(latEdges[i * 2 - 1]);
    }
  });
});

describe('the centre is a representative, and says so', () => {
  it('returns the middle of the box with the half-span either side', () => {
    const point = maidenheadRepresentativePoint('FN31pr');
    expect(point).toEqual({
      locator: 'FN31pr',
      precision: 6,
      representativeLat: 41.72916666666667,
      representativeLon: -72.70833333333334,
      latUncertaintyDeg: 1 / 48,
      lonUncertaintyDeg: 1 / 24,
    });
  });

  it('carries an uncertainty that grows with the coarseness of the locator', () => {
    // The point of the field: `FN`'s representative is 5 degrees of latitude — roughly 345 miles
    // of longitude at this latitude — away from where the station might be. A caller that treats
    // it as an address is not slightly wrong.
    const field = maidenheadRepresentativePoint('FN');
    expect(field?.latUncertaintyDeg).toBe(5);
    expect(field?.lonUncertaintyDeg).toBe(10);
    const subsquare = maidenheadRepresentativePoint('FN31pr');
    expect(subsquare?.latUncertaintyDeg).toBeLessThan(field?.latUncertaintyDeg ?? 0);
  });

  it('puts its own representative inside its own box, at every precision', () => {
    for (const locator of ['FN', 'FN31', 'FN31pr', 'FN31pr43', 'AA', 'RR99xx99', 'JJ00aa']) {
      const box = maidenheadBox(locator);
      expect(box).toBeDefined();
      if (box === undefined) return;
      const point = boxRepresentativePoint(box);
      expect(
        boxContainsCoordinate(box, point.representativeLat, point.representativeLon),
      ).toBe(true);
    }
  });

  it('has no field called lat or lon, so it cannot be passed off as a location', () => {
    // This is a design assertion, not a formality: `GeoLocation` in geo.ts is `{ lat?, lon? }`,
    // and a `{ lat, lon }` here would be structurally assignable to it. The rename is the only
    // thing making a caller stop and convert.
    const point = maidenheadRepresentativePoint('FN31pr');
    expect(point).toBeDefined();
    expect(Object.keys(point ?? {}).sort()).toEqual([
      'latUncertaintyDeg',
      'locator',
      'lonUncertaintyDeg',
      'precision',
      'representativeLat',
      'representativeLon',
    ]);
  });
});

describe('case, whitespace and canonical spelling', () => {
  it('reads any case and stores one', () => {
    for (const spelling of ['FN31PR', 'fn31pr', 'Fn31Pr', ' FN31pr ', '\tfn31PR\n']) {
      expect(canonicalMaidenhead(spelling)).toBe('FN31pr');
      expect(maidenheadBox(spelling)?.south).toBe(maidenheadBox('FN31pr')?.south);
    }
  });

  it('canonicalises the eight-character form too', () => {
    expect(canonicalMaidenhead('fn31PR43')).toBe('FN31pr43');
  });
});

describe('rejection, not half-parsing', () => {
  it('rejects odd lengths rather than reading the pairs it can', () => {
    for (const locator of ['F', 'FN3', 'FN31p', 'FN31pr4']) {
      const parsed = parseMaidenhead(locator);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.rejection.kind).toBe('odd_length');
    }
  });

  it('rejects more than eight characters rather than truncating', () => {
    const parsed = parseMaidenhead('FN31pr43aa');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.rejection).toEqual(
      expect.objectContaining({ kind: 'too_long', length: 10 }),
    );
  });

  it('rejects the empty string and pure whitespace', () => {
    for (const locator of ['', '   ', '\n']) {
      const parsed = parseMaidenhead(locator);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.rejection.kind).toBe('empty');
    }
  });

  it('holds the first pair to A-R, not A-Z and not A-X', () => {
    // S..Z would place a station past the antimeridian or past the pole. A-X is the THIRD pair's
    // range, and accepting it here is the classic version of this bug.
    for (const letter of ['S', 'T', 'W', 'X', 'Y', 'Z']) {
      expect(maidenheadBox(`${letter}N31pr`)).toBeUndefined();
      expect(maidenheadBox(`F${letter}31pr`)).toBeUndefined();
    }
    expect(maidenheadBox('RR')).toBeDefined();
  });

  it('holds the third pair to A-X, and lets X through', () => {
    expect(maidenheadBox('FN31xx')).toBeDefined();
    for (const letter of ['Y', 'Z']) {
      expect(maidenheadBox(`FN31${letter}x`)).toBeUndefined();
      expect(maidenheadBox(`FN31x${letter}`)).toBeUndefined();
    }
  });

  it('requires digits where digits belong and letters where letters belong', () => {
    expect(maidenheadBox('3131pr')).toBeUndefined();
    expect(maidenheadBox('FNAApr')).toBeUndefined();
    expect(maidenheadBox('FN3131')).toBeUndefined();
    expect(maidenheadBox('FN31prAA')).toBeUndefined();
  });

  it('names the offending character and what was expected there', () => {
    const parsed = parseMaidenhead('FZ31pr');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.rejection).toEqual({
      kind: 'character',
      index: 1,
      character: 'Z',
      expected: 'A-R',
      message: 'character 2 of the locator is "Z"; pair 1 takes A-R',
    });
  });

  it('rejects a non-ASCII character that would upper-case into range', () => {
    // U+0131 DOTLESS I upper-cases to "I" in JavaScript. "ıN31pr" is a mojibake accident,
    // not IN31pr, and reading it as a location would put a station 60 degrees east.
    expect('ı'.toUpperCase()).toBe('I');
    expect(maidenheadBox('ıN31pr')).toBeUndefined();
    expect(maidenheadBox('FN31ır')).toBeUndefined();
  });

  it('rejects punctuation and internal spaces rather than stripping them', () => {
    for (const locator of ['FN-31pr', 'FN 31pr', 'FN31.pr', 'FN31p ']) {
      expect(maidenheadBox(locator)).toBeUndefined();
    }
  });
});

describe('the corners of the world, where this arithmetic goes wrong', () => {
  it('places the south pole and the prime-meridian/equator corner exactly', () => {
    expect(maidenheadBox('AA')).toEqual(
      expect.objectContaining({ south: -90, west: -180, north: -80, east: -160 }),
    );
    // The equator and the prime meridian are box edges, not box interiors: JJ starts at exactly
    // (0, 0), and a hair south or west of that is a different field in both characters.
    expect(maidenheadBox('JJ')).toEqual(
      expect.objectContaining({ south: 0, west: 0, north: 10, east: 20 }),
    );
    expect(coordinateToLocator(0, 0, 2)).toBe('JJ');
    expect(coordinateToLocator(-0.000001, -0.000001, 2)).toBe('II');
    expect(coordinateToLocator(0, -0.000001, 2)).toBe('IJ');
    expect(coordinateToLocator(-0.000001, 0, 2)).toBe('JI');
  });

  it('makes the north edge of the top row exactly 90, not nearly 90', () => {
    // Not a formality. `boxContainsCoordinate` recognises the pole row by `north === 90`, and
    // that test can only work if adding the cells lands on 90 exactly — which is why the module
    // does integer arithmetic on cells and divides once.
    for (const locator of ['AR', 'AR09', 'AR09ax', 'AR09ax09']) {
      expect(maidenheadBox(locator)?.north).toBe(90);
    }
    for (const locator of ['AA', 'AA00', 'AA00aa', 'AA00aa00']) {
      expect(maidenheadBox(locator)?.south).toBe(-90);
      expect(maidenheadBox(locator)?.west).toBe(-180);
    }
  });

  it('gives the poles a box and puts them in it', () => {
    // Latitude 90 has no box above it, so the top row must include its north edge or the pole
    // belongs to nothing. Latitude -90 is the ordinary inclusive south edge.
    for (const precision of MAIDENHEAD_PRECISIONS) {
      const north = coordinateToLocator(90, 0, precision);
      expect(north).toBeDefined();
      if (north === undefined) return;
      const northBox = maidenheadBox(north);
      expect(northBox?.north).toBe(90);
      expect(boxContainsCoordinate(northBox!, 90, 0)).toBe(true);
      expect(checkCoordinateAgainstLocator(90, 0, north).status).toBe('inside');

      const south = coordinateToLocator(-90, 0, precision);
      expect(south).toBeDefined();
      if (south === undefined) return;
      const southBox = maidenheadBox(south);
      expect(southBox?.south).toBe(-90);
      expect(boxContainsCoordinate(southBox!, -90, 0)).toBe(true);
    }
    expect(coordinateToLocator(90, 0, 2)).toBe('JR');
    expect(coordinateToLocator(-90, 0, 2)).toBe('JA');
  });

  it('rejects a latitude past the pole instead of wrapping it', () => {
    // Longitude wraps because the meridians do. Latitude does not: 91 is not 89 on the other
    // side, it is a broken record, and quietly folding it would invent a location.
    for (const lat of [90.0001, 91, -90.0001, -91, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(coordinateToLocator(lat, 0, 6)).toBeUndefined();
      const agreement = checkCoordinateAgainstLocator(lat, 0, 'FN31pr');
      expect(agreement.status).toBe('unknown');
      if (agreement.status !== 'unknown') return;
      expect(agreement.rejection.kind).toBe('latitude_out_of_range');
    }
  });

  it('folds the antimeridian to one side and keeps the round trip', () => {
    expect(wrapLongitudeDeg(180)).toBe(-180);
    expect(wrapLongitudeDeg(-180)).toBe(-180);
    expect(wrapLongitudeDeg(540)).toBe(-180);
    expect(wrapLongitudeDeg(-181)).toBe(179);
    expect(wrapLongitudeDeg(181)).toBe(-179);
    for (const precision of MAIDENHEAD_PRECISIONS) {
      // +180 and -180 are the same meridian, so they must produce the same box, and the box has
      // to contain the coordinate written either way.
      const west = coordinateToLocator(0, -180, precision);
      expect(coordinateToLocator(0, 180, precision)).toBe(west);
      const box = maidenheadBox(west ?? '');
      expect(box?.west).toBe(-180);
      expect(boxContainsCoordinate(box!, 0, 180)).toBe(true);
      expect(boxContainsCoordinate(box!, 0, -180)).toBe(true);
      // 540 is the antimeridian a lap and a half round; 360 would be the PRIME meridian.
      expect(boxContainsCoordinate(box!, 0, 540)).toBe(true);
    }
    // A hair west of the antimeridian is the far side of the world: field R, not field A.
    expect(coordinateToLocator(0, 179.999999, 2)).toBe('RJ');
    expect(coordinateToLocator(0, -179.999999, 2)).toBe('AJ');
  });

  it('treats a longitude just past 180 as the eastern edge of field A', () => {
    expect(coordinateToLocator(0, 180.5, 2)).toBe('AJ');
    expect(maidenheadBox('RJ')?.east).toBe(180);
    // 180 belongs to A, not R, because the box is half-open at its east edge.
    expect(boxContainsCoordinate(maidenheadBox('RJ')!, 0, 180)).toBe(false);
  });

  it('leaves a longitude that is already in range bit-for-bit alone', () => {
    // Regression, found by the adjacent-box test below. The fold used to run unconditionally, and
    // `(lon + 180) % 360 - 180` is NOT the identity: -72.666666666666671 (FN31pr's east edge)
    // came back as -72.666666666666686, 1.4e-14 to the west of where it started — the far side of
    // the boundary — so a coordinate sitting exactly on the edge was inside both boxes.
    for (const lon of [-72.66666666666667, -180, -0.1, 0, 1 / 3, 179.99999999999997]) {
      expect(wrapLongitudeDeg(lon)).toBe(lon);
    }
  });

  it('keeps adjacent boxes half-open so a coordinate is in exactly one', () => {
    const lower = maidenheadBox('FN31pr')!;
    const above = maidenheadBox('FN31ps')!;
    expect(above.south).toBe(lower.north);
    expect(boxContainsCoordinate(lower, lower.north, -72.7)).toBe(false);
    expect(boxContainsCoordinate(above, lower.north, -72.7)).toBe(true);
    const right = maidenheadBox('FN31qr')!;
    expect(right.west).toBe(lower.east);
    expect(boxContainsCoordinate(lower, 41.72, lower.east)).toBe(false);
    expect(boxContainsCoordinate(right, 41.72, lower.east)).toBe(true);
  });
});

describe('checkCoordinateAgainstLocator — the reason the pair of fields is worth having', () => {
  it('says a record disagrees with itself, and by how much and with what', () => {
    // W1AW's own coordinate against the grid square of a station 100 miles away.
    const agreement = checkCoordinateAgainstLocator(W1AW.lat, W1AW.lon, 'FN42li');
    expect(agreement.status).toBe('outside');
    if (agreement.status !== 'outside') return;
    expect(agreement.containingLocator).toBe('FN31pr');
    // FN42li's box is north and east of W1AW: the offsets say which way and how far.
    expect(agreement.latOffsetDeg).toBeLessThan(0);
    expect(agreement.lonOffsetDeg).toBeLessThan(0);
    expect(agreement.latOffsetDeg).toBeCloseTo(W1AW.lat - 42.333333, 5);
    expect(agreement.lonOffsetDeg).toBeCloseTo(W1AW.lon - -71.083333, 5);
  });

  it('separates a boundary-rounding miss from a genuinely different place', () => {
    // Both are `outside`; only the offset tells a caller whether to raise its voice. A geocoder
    // that rounds a coordinate a ten-thousandth of a degree over an edge is not the same event as
    // a record naming the wrong square, and downstream copy should not read the same.
    const box = maidenheadBox('FN31pr')!;
    const hair = checkCoordinateAgainstLocator(box.south - 0.0001, -72.7, 'FN31pr');
    expect(hair.status).toBe('outside');
    if (hair.status !== 'outside') return;
    expect(Math.abs(hair.latOffsetDeg)).toBeCloseTo(0.0001, 9);
    expect(Math.abs(hair.lonOffsetDeg)).toBe(0);

    const elsewhere = checkCoordinateAgainstLocator(34.05, -118.25, 'FN31pr');
    expect(elsewhere.status).toBe('outside');
    if (elsewhere.status !== 'outside') return;
    expect(Math.abs(elsewhere.latOffsetDeg)).toBeGreaterThan(7);
    expect(Math.abs(elsewhere.lonOffsetDeg)).toBeGreaterThan(45);
    // Downtown Los Angeles, hand-checked: lon field D (3), lat field M (12), square 04,
    // subsquare v (lon cell 21 of 24) b (lat cell 1 of 24).
    expect(elsewhere.containingLocator).toBe('DM04vb');
  });

  it('measures the offset the short way around the antimeridian', () => {
    // A point 1 degree east of a box that ends at 180 is 1 degree away, not 359.
    const agreement = checkCoordinateAgainstLocator(0, -179, 'RJ');
    expect(agreement.status).toBe('outside');
    if (agreement.status !== 'outside') return;
    expect(agreement.lonOffsetDeg).toBeCloseTo(1, 9);
    expect(agreement.latOffsetDeg).toBe(0);
  });

  it('reports zero offset on the axis that is inside', () => {
    const agreement = checkCoordinateAgainstLocator(W1AW.lat, -75, 'FN31pr');
    expect(agreement.status).toBe('outside');
    if (agreement.status !== 'outside') return;
    expect(agreement.latOffsetDeg).toBe(0);
    expect(agreement.lonOffsetDeg).toBeLessThan(0);
  });

  it('answers unknown, not outside, when the locator itself is unreadable', () => {
    // An unreadable grid square is silence about the coordinate. Reporting `outside` would let a
    // caller flag a record as self-contradictory on the strength of a typo.
    for (const locator of ['', 'FN31p', 'FZ31pr', 'not a locator']) {
      const agreement = checkCoordinateAgainstLocator(W1AW.lat, W1AW.lon, locator);
      expect(agreement.status).toBe('unknown');
    }
  });

  it('answers unknown for a non-finite longitude', () => {
    const agreement = checkCoordinateAgainstLocator(41.7, Number.NaN, 'FN31pr');
    expect(agreement.status).toBe('unknown');
    if (agreement.status !== 'unknown') return;
    expect(agreement.rejection.kind).toBe('longitude_not_finite');
  });

  it('accepts a coarse locator that contains a fine coordinate', () => {
    // A station that states only `FN` is not disagreeing with its own coordinate; it is being
    // vague. `inside` is the right answer and the uncertainty is the caller's problem.
    expect(checkCoordinateAgainstLocator(W1AW.lat, W1AW.lon, 'FN').status).toBe('inside');
    expect(checkCoordinateAgainstLocator(W1AW.lat, W1AW.lon, 'FN31').status).toBe('inside');
  });
});

describe('round trip: coordinate -> locator -> bounds contains the original coordinate', () => {
  /**
   * A deterministic sweep. `Math.random` would make a failure unreproducible, so this is a plain
   * 32-bit LCG (Numerical Recipes constants) seeded by hand — no dependency, same 500 coordinates
   * on every run and every machine.
   */
  function lcg(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
  }

  it('holds for 500 pseudo-random coordinates at every precision', () => {
    const next = lcg(20260811);
    const failures: string[] = [];
    for (let i = 0; i < 500; i += 1) {
      const lat = next() * 180 - 90;
      const lon = next() * 360 - 180;
      for (const precision of MAIDENHEAD_PRECISIONS) {
        const locator = coordinateToLocator(lat, lon, precision);
        if (locator === undefined) {
          failures.push(`${lat},${lon} @${precision}: no locator`);
          continue;
        }
        if (locator.length !== precision) {
          failures.push(`${lat},${lon} @${precision}: got ${locator}`);
          continue;
        }
        const box = maidenheadBox(locator);
        if (box === undefined) {
          failures.push(`${lat},${lon} @${precision}: ${locator} does not parse`);
          continue;
        }
        if (!boxContainsCoordinate(box, lat, lon)) {
          failures.push(`${lat},${lon} @${precision}: ${locator} does not contain it`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('holds on the edges themselves, which is where floating point bites', () => {
    // Every coordinate here is exactly on a box boundary at some precision, or at a limit of the
    // coordinate system. These are the cases where `floor((lat + 90) * 240)` and the edge
    // arithmetic can disagree by one cell and silently produce a box that excludes its own input.
    const lats = [-90, -89.99999, -45, -1 / 24, 0, 1 / 24, 41.708333333333336, 41.75, 89.95833333333333, 90];
    const lons = [-180, -179.99999, -72.75, -1 / 12, 0, 1 / 12, 179.99999, 180, -0.0000001];
    const failures: string[] = [];
    for (const lat of lats) {
      for (const lon of lons) {
        for (const precision of MAIDENHEAD_PRECISIONS) {
          const locator = coordinateToLocator(lat, lon, precision);
          if (locator === undefined) {
            failures.push(`${lat},${lon} @${precision}: no locator`);
            continue;
          }
          const box = maidenheadBox(locator);
          if (box === undefined || !boxContainsCoordinate(box, lat, lon)) {
            failures.push(`${lat},${lon} @${precision}: ${locator} does not contain it`);
            continue;
          }
          if (checkCoordinateAgainstLocator(lat, lon, locator).status !== 'inside') {
            failures.push(`${lat},${lon} @${precision}: ${locator} disagrees`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('holds through the canonical spelling and the representative point', () => {
    // locator -> box -> centre -> locator must return the same locator: a centre that rounded out
    // of its own box would be a location error nothing else here would catch.
    const next = lcg(7);
    for (let i = 0; i < 200; i += 1) {
      const lat = next() * 180 - 90;
      const lon = next() * 360 - 180;
      const locator = coordinateToLocator(lat, lon, 6);
      expect(locator).toBeDefined();
      if (locator === undefined) return;
      expect(canonicalMaidenhead(locator.toUpperCase())).toBe(locator);
      const point = maidenheadRepresentativePoint(locator);
      expect(point).toBeDefined();
      if (point === undefined) return;
      expect(
        coordinateToLocator(point.representativeLat, point.representativeLon, 6),
      ).toBe(locator);
    }
  });
});
