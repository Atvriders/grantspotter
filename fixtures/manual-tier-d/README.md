# fixtures/manual-tier-d

`manual-tier-d` has `requests: []` and `parse()` ignores its argument — see
`packages/server/src/sources/manual-tier-d.ts`. There is no fetched payload to fixture; the
records themselves are the fixture, and they live directly in `TIER_D_RECORDS` in that file.

This file exists only so `registry.test.ts`'s "every registered source has a fixture directory"
invariant has something to find. `expectedMinRecords` is 15 (not 0), so the test's empty-scrape
exemption — `expectedMinRecords === 0 && requests.length === 0` — does not apply here even
though this source makes zero network requests.
