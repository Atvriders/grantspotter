# fixtures/callook

Bodies for `packages/server/src/callsign/callook.ts`, the one-request-per-person callsign lookup.

**Two kinds of file live here, and the file name says which:** `NN-<host>-<path>.json` is a REAL
capture of a live URL; everything else is HAND-BUILT in the documented shape. The reason for the
second kind is not convenience — see [Why there is not a real PERSON record in
here](#why-there-is-not-a-real-person-record-in-here).

## The real captures

Taken 2026-08-04 with `curl`, one at a time, two seconds apart. Every one was `HTTP 200` with
`content-type: application/json; charset=utf-8`.

```
curl -A "GrantSpotter fixture capture (one-off manual capture; +<your CONTACT_URL>)" \
     https://callook.info/W1AW/json
```

`npm run capture-fixture` was NOT used and cannot be: that command drives the crawler's fetcher,
which reads `robots.txt` first, and callook's is `Disallow: /` (see below). These four are hand-run
`curl` captures, which is why the command is written out here in full.

| file | callsign | what it is | bytes as committed |
| --- | --- | --- | --- |
| `00-callook-info-w1aw-json.json` | W1AW | ARRL headquarters. A club station at an institutional address, plain 5-digit ZIP. | 823 |
| `01-callook-info-w1mx-json.json` | W1MX | MIT Radio Society. A collegiate club — the primary audience — at a **PO box**, with a **ZIP+4**. | 828 |
| `02-callook-info-k2cc-json.json` | K2CC | Clarkson University Amateur Radio Club. `line1` is a street address that ALSO carries a PO box. | 854 |
| `03-callook-info-al0zzz-json.json` | AL0ZZZ | A well-formed, currently unissued US callsign: the whole `INVALID` body, 27 bytes, served with HTTP **200**. | 27 |

All four are byte-identical to the wire, including the absence of a trailing newline, except for
the redaction below.

### The one edit made to these files

Three fields have had their values replaced with the literal string `[redacted]`:

| field | values replaced | in |
| --- | --- | --- |
| `trustee.callsign` | 3 | `00`, `01`, `02` |
| `trustee.name` | 3 | `00`, `01`, `02` |
| `address.attn` | 3 | `00`, `01`, `02` |

Each of the three names the club's **trustee of record — a named private individual** — and
`trustee.callsign` is a lookup key that resolves, through this same API, to that person's home
address. `lookupCallsign` reads none of the three. The same reasoning, and the same treatment, as
the 125 researchers' contact details in [`fixtures/nsf-awards/README.md`](../nsf-awards/README.md).

**Nothing else was touched.** The club name, both address lines, the coordinates, the grid square,
the dates, the FRN and the ULS link are exactly as callook returned them, and those are the fields
the parser actually reads.

## The hand-built bodies

| file | what it pins |
| --- | --- |
| `person-extra.json` | The canonical PERSON shape: `EXTRA`, a street address, a ZIP+4, and a **`previous.callsign`** — the vanity case. |
| `person-general.json`, `person-technician.json` | The other two classes that map onto core's `LicenseClass` exactly. |
| `person-advanced.json`, `person-novice.json`, `person-technician-plus.json` | The three legacy classes that must leave `operClass` **undefined** while keeping `operClassRaw`. ~212,000 people hold one. |
| `person-no-address.json` | A record with every address field empty. About 1.3% of records are like this. |
| `person-unsplittable-address.json` | `line2` is `EXAMPLEVILLE, EXAMPLESHIRE` — it has a comma, so a naive splitter sets `state` to a county. All three of `city`/`state`/`zip` must come back undefined. |
| `updating.json` | The daily-import answer, which must never be shown as "callsign not found". |

The six class files in the first three rows are **one imaginary licensee with one field changed** —
`operClass` — because that one field is the entire difference the parser is being asked to notice.

Everything invented in them is invented visibly:

- **The licensee is `ALEX Q EXAMPLE` at `123 EXAMPLE ST, EXAMPLEVILLE, KS 00000-0000`.** `00000` is
  not an assigned ZIP. The name is in the shape a real PERSON record prints (`FIRST M LAST`,
  upper case, which was confirmed by reading a real record and printing only its letter-pattern,
  never its value).
- **The callsigns `WV0ZZZ`, `NV0ZZZ`, `AJ0ZZZ` and `KV0ZZZ` were each checked against the live API
  on 2026-08-04 and all four answered `INVALID`** — they are well-formed US callsigns that nobody
  holds. A callsign invented without checking would eventually be somebody's, and this file would
  then be a fabricated claim about a real licensee. (Unissued today is not unissued forever: if one
  of these is ever granted, re-check and rename it.)
- **`frn` is `0000000000`, `ulsUrl` ends `licKey=0`, and the coordinates are `0.0, 0.0`.** None of
  them is a real key.
- **`grantDate 04/04/2019` beside `previous.callsign KV0ZZZ` is copied from the SHAPE of a real
  record** — a licensee whose current grant dates from a vanity change years after they were first
  licensed. That pair is the whole reason `licensedSince` must never be filled from `grantDate`,
  so the fixture that proves the rule carries the shape that motivates it. The date is the only
  thing taken; the record it came from is not in this repository.

`updating.json` is 28 bytes of documented shape, not a capture: the API reference states that when
`status` is not `VALID`, "status is the only field that will appear in the output", and the
`INVALID` capture beside it confirms that byte-for-byte. The daily import lasts under five minutes
and cannot be waited for on demand.

## Why there is not a real PERSON record in here

**A callsign record is a private person's full name and home address.** The FCC publishes them and
callook serves them, and neither of those facts makes it acceptable for this repository — which is
public, and which ships a seed validator that refuses a committed private address — to republish
one so that a parser test has something to chew on. Club records are different in kind: the address
is an institution's and the organisation name is the licensee. So the real captures are all clubs,
the PERSON cases are invented, and this paragraph is here so that nobody later "improves" the
fixtures by capturing a friend's callsign.

## What the captures established about the source

- **`https://callook.info/robots.txt` is `User-agent: *` / `Disallow: /`** (HTTP 200, 26 bytes,
  `last-modified: Wed, 10 Apr 2024`). The crawler's fetcher would therefore refuse this URL, which
  is one of the reasons `callook.ts` is not built on it. The same site's API reference, under
  *Usage Terms*, reads: "The callook.info API is publicly available and is free to use however you
  wish." Both documents are the site owner's and they address different clients — robots.txt binds
  automatic clients that go looking for URLs, and this lookup is one request a person makes about
  their own licence. The full argument, and the limits it puts on the code, are at the top of
  `packages/server/src/callsign/callook.ts`.
- **`INVALID` is served with HTTP 200.** The status lives in the body; the HTTP code says nothing.
- **A superseded callsign is answered with the holder's CURRENT record** ("Whenever data is
  requested for a callsign that is not active/currently held, but is an old callsign of a currently
  active licensee, the site and API will seamlessly serve the data for that licensee's current
  callsign"). `current.callsign` is therefore not always the callsign that was asked for, and the
  parser returns what the source said rather than what the user typed.
- **`type` is one of `CLUB | MILITARY | RACES | RECREATION | PERSON`** and `operClass` is one of
  `NOVICE | TECHNICIAN | TECHNICIAN PLUS | GENERAL | ADVANCED | EXTRA` or empty — both quoted from
  the API reference's own table of structured fields, both pinned by tests.
- **The database reloads daily at about 11:00 ET** and the site is offline while it does, "usually
  less than five minutes". That is the sentence the `updating` message is built from.

To refresh a capture: re-run the `curl` above, then re-apply the redaction table before committing.
Refreshing a fixture is a deliberate, reviewable act — read the diff.
