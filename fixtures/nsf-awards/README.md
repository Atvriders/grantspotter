# fixtures/nsf-awards

`00-*.json` … `04-*.json` are a **real capture** of `api.nsf.gov/services/v1/awards.json`, taken
2026-08-03 through the production fetcher (`npm run capture-fixture -- nsf-awards`), one file per
keyword in `KEYWORDS`. Every response was `HTTP 200`, `content-type: application/json`, 25 awards.

## The one edit made to these files

Four contact fields have had their values replaced with the literal string `[redacted]`:

| field | values replaced |
| --- | --- |
| `piEmail` | 125 |
| `awardeePhone` | 125 |
| `poEmail` | 120 |
| `poPhone` | 120 |

These are the personal email addresses and direct phone numbers of named researchers and NSF
program officers. This repository is public; there is no reason for a parser test fixture to
republish 125 people's contact details, and `parseNsfAwards` reads none of these fields. The JSON
was re-serialised compactly by the redaction pass, so whitespace differs from the wire bytes.

**Nothing else was touched.** Award ids, titles, abstracts, awardee names, dates, program names and
every other key are exactly as the API returned them.

## What the capture proves

The response carries **61 fields per award**, not the 8 named in `printFields`. That is not an
artefact of this fixture — it was re-measured directly against the live API on the same day, with
and without `printFields`, and the field set is identical either way. See the `notes` on
`sources/nsf-awards.ts` for the two previously-documented API facts this capture disproves.

To refresh: `CONTACT_URL=<url> npm run capture-fixture -- nsf-awards`, then re-run the redaction
above before committing.
