// node scripts/make-extract-fixture.mjs
// Dev-only. Regenerates BOTH synthetic archives under fixtures/grants-gov-extract/ — real ZIP
// files containing one XML member, small enough to commit and review. Production is 77.9 MB.
//
//   00-extract.zip.b64            sizes in the local file header (a seekable writer)
//   01-extract-streamed.zip.b64   sizes only in a trailing data descriptor (a STREAMING writer)
//
// THE SECOND ONE IS THE SHAPE GRANTS.GOV ACTUALLY SENDS, and it exists because for the life of this
// module only the first one did. `unzipFirstEntry` read the compressed size out of the local
// header, where a streaming writer leaves a zero, inflated an empty buffer, threw, and was caught
// as "a day we skip" — on all seven days, every night. The fixture stayed green because the
// generator below filled in the field the real writer leaves blank. See fixtures/*/README.md for
// the 2026-08-10 measurement of the live file and the 59 bytes of it committed as proof.
//
// NOTE: node:zlib's crc32 export landed in Node 20.15; this host runs 20.11, so CRC-32 is
// computed here rather than imported. Twelve lines beats a version floor.
import { deflateRawSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<Grants xmlns="http://apply.grants.gov/system/OpportunityDetail-V1.0">
  <OpportunitySynopsisDetail_1_0>
    <OpportunityID>354102</OpportunityID>
    <OpportunityNumber>NSF 26-512</OpportunityNumber>
    <OpportunityTitle>Geospace Facilities</OpportunityTitle>
    <AgencyName>National Science Foundation</AgencyName>
    <Description>Operation of geospace observing facilities including incoherent scatter radar and ionospheric sounding instrumentation for radio science research.</Description>
    <PostDate>07062026</PostDate>
    <CloseDate>11142026</CloseDate>
    <OppStatus>posted</OppStatus>
  </OpportunitySynopsisDetail_1_0>
  <OpportunitySynopsisDetail_1_0>
    <OpportunityID>354777</OpportunityID>
    <OpportunityNumber>NTIA-26-PWSCIF</OpportunityNumber>
    <OpportunityTitle>Public Wireless Supply Chain Innovation Fund</OpportunityTitle>
    <AgencyName>National Telecommunications and Information Administration</AgencyName>
    <Description>Open radio access network testbeds, spectrum sharing research, and amateur radio spectrum education partnerships.</Description>
    <PostDate>02012026</PostDate>
    <CloseDate>05012026</CloseDate>
    <OppStatus>posted</OppStatus>
  </OpportunitySynopsisDetail_1_0>
  <OpportunitySynopsisDetail_1_0>
    <OpportunityID>351020</OpportunityID>
    <OpportunityNumber>HHS-2026-RAD</OpportunityNumber>
    <OpportunityTitle>Radiation Oncology Outcomes Research</OpportunityTitle>
    <AgencyName>Department of Health and Human Services</AgencyName>
    <Description>Clinical outcomes research in radiation oncology and survivorship care.</Description>
    <PostDate>03012026</PostDate>
    <CloseDate>09012026</CloseDate>
    <OppStatus>posted</OppStatus>
  </OpportunitySynopsisDetail_1_0>
</Grants>
`;

const raw = Buffer.from(XML, 'utf8');
const deflated = deflateRawSync(raw, { level: 9 });
const crc = crc32(raw);

// `streamed` reproduces APPNOTE 4.4.4 bit 3: crc-32 and both sizes are ZERO in the local header
// and are restated in a 16-byte data descriptor after the compressed bytes. Bit 11 (UTF-8 name)
// rides along with it, so the flag word is 0x0808 — byte-for-byte what the live file carries.
function buildZip(streamed) {
  const name = Buffer.from(`GrantsDBExtract2026080${streamed ? '3' : '2'}v2.xml`, 'ascii');
  const flags = streamed ? 0x0808 : 0;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);                             // version needed
  local.writeUInt16LE(flags, 6);
  local.writeUInt16LE(8, 8);                              // method: deflate
  local.writeUInt16LE(0, 10);                             // time
  local.writeUInt16LE(0x2101, 12);    // date (fixed, so the file is byte-deterministic)
  local.writeUInt32LE(streamed ? 0 : crc, 14);
  local.writeUInt32LE(streamed ? 0 : deflated.length, 18);
  local.writeUInt32LE(streamed ? 0 : raw.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);

  // The optional PK\x07\x08 signature is present, because Grants.gov's writer emits it — see the
  // 113 committed trailer bytes in the README.
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(crc, 4);
  descriptor.writeUInt32LE(deflated.length, 8);
  descriptor.writeUInt32LE(raw.length, 12);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(flags, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0x2101, 14);
  // ALWAYS the real values, even when the local header's are zero. This is why the reader takes
  // its sizes from here: the central directory is written after the data, so it always knows.
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(deflated.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);       // local header offset

  const entry = streamed
    ? [local, name, deflated, descriptor]
    : [local, name, deflated];
  const entryLength = entry.reduce((n, part) => n + part.length, 0);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(entryLength, 16);

  return Buffer.concat([...entry, central, name, end]);
}

mkdirSync('fixtures/grants-gov-extract', { recursive: true });
for (const [file, streamed] of [
  ['00-extract.zip.b64', false],
  ['01-extract-streamed.zip.b64', true],
]) {
  const zip = buildZip(streamed);
  writeFileSync(`fixtures/grants-gov-extract/${file}`, zip.toString('base64'));
  console.log(`wrote ${zip.length} bytes of ZIP as base64 -> ${file}`);
}
