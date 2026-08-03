/**
 * Approximate place centroids for the radius-based scholarship regions observed in the ARRL
 * catalog ("within 250 miles of Seaford, Delaware", "within 70 miles of Schenectady, NY",
 * "within 175 miles of Erving, MA"). We never geocode at runtime — there is no network on this
 * path, and `normalize/` is pure (spec §14), so this is inlined rather than read from disk.
 *
 * `data/reference/radius-centers.json` is the reviewable copy of the same data. The two are
 * asserted equal by packages/server/src/normalize/purity.test.ts — edit BOTH or the suite fails.
 *
 * Source: US Census Gazetteer place centroids, rounded to 4 decimals. Used only to test radius
 * membership; never rendered as an exact location.
 */
export const RADIUS_CENTERS: Readonly<Record<string, { lat: number; lon: number }>> = Object.freeze({
  'seaford, delaware': { lat: 38.6412, lon: -75.6116 },
  'schenectady, ny': { lat: 42.8142, lon: -73.9396 },
  'erving, ma': { lat: 42.5987, lon: -72.4009 },
});
