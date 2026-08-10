# fixtures/grants-gov-extract

Four files. Two are **synthetic archives** a generator writes; two are **verbatim bytes of the live
Grants.gov daily extract**. The split exists because the production file is 77.9 MB and cannot be
committed, and because the synthetic one alone hid a bug for the whole life of the module.

| file | what it is |
| --- | --- |
| `00-extract.zip.b64` | synthetic; sizes stated in the local file header |
| `01-extract-streamed.zip.b64` | synthetic; sizes stated only in a trailing data descriptor — **the shape Grants.gov sends** |
| `real-local-file-header.b64` | the live file's first 59 bytes, unmodified |
| `real-central-directory.b64` | the live file's last 113 bytes, unmodified |

Both synthetic archives are regenerated together by `node scripts/make-extract-fixture.mjs`, which
is dev-only and is never run by CI or by a test.

## The real capture

    curl -A "GrantSpotter/0.1.0 (+<CONTACT_URL>; …)" \
      https://prod-grants-gov-chatbot.s3.amazonaws.com/extracts/GrantsDBExtract20260809v2.zip

taken **2026-08-10**. `HTTP 200`, `content-type: application/zip`, `content-length: 77899674`,
`last-modified: Sun, 09 Aug 2026 08:43:39 GMT`. `https://prod-grants-gov-chatbot.s3.amazonaws.com/robots.txt`
was read first and answered `HTTP 404` — the bucket publishes no rules, which
`fetcher/robots.ts` reads as "crawl freely" (see the enumeration on `robotsFromResponse`).

Inflated, the single member is **319,892,165 bytes of XML holding 82,230
`OpportunitySynopsisDetail_1_0` elements**, of which 89 score at or above `ADJACENCY_THRESHOLD`.
The feed was not empty on any reading.

## The one thing done to these files

| file | edit | bytes changed |
| --- | --- | --- |
| `real-local-file-header.b64` | none — bytes `0…58` of the download, base64'd | 0 |
| `real-central-directory.b64` | none — bytes `77899561…77899673` of the download, base64'd | 0 |

**Nothing was altered.** What was done is a TRUNCATION, not an edit: the 77.9 MB of deflate stream
between those two slices is omitted, so neither file is a working archive and neither can be
handed to `unzipFirstEntry`. They are committed as evidence of a *shape*, and the two tests that
read them (`grants-gov-extract.test.ts`) assert on header fields only.

There is nothing to redact. A ZIP frame carries a file name, four integers and two timestamps; the
personal data this repository's other captures have to strip does not exist in it.

To re-obtain exactly these bytes without downloading 77.9 MB, while the day is still inside the
~7-day retention window:

    curl -r 0-58   …/GrantsDBExtract20260809v2.zip | base64 -w0   # real-local-file-header.b64
    curl -r -113   …/GrantsDBExtract20260809v2.zip | base64 -w0   # real-central-directory.b64

## What the capture proves

The live archive is written by a STREAMING writer. Its local file header says:

    general purpose bit flag  0x0808     bit 3 — sizes follow the data; bit 11 — UTF-8 name
    crc-32                    0
    compressed size           0
    uncompressed size         0

and the true values (`crc 1966468460`, `compressed 77899502`, `uncompressed 319892165`) appear
twice afterwards: once in a 16-byte data descriptor behind the deflate stream, and once in the
central directory record. The end-of-central-directory record states **one** entry.

`unzipFirstEntry` read the compressed size out of the local header, got `0`, sliced an empty
buffer, and `inflateRawSync` threw `unexpected end of file`. `sources/grants-gov-extract.ts` caught
that as "a truncated day, skip it" and did so for all seven days of the retention window, every
night, and reported `Parsed 0 records` — indistinguishable, in the database row, from a federal
corpus that happened to contain nothing.

`00-extract.zip.b64` could never have caught this: the generator that writes it fills the local
header's size fields in, which is the one field the real writer leaves blank.
`01-extract-streamed.zip.b64` reproduces the real flag word and the real trailing descriptor, and
fails against the old reader for exactly the reason the live file did.
