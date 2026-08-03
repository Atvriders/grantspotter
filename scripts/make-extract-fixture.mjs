// node scripts/make-extract-fixture.mjs
// Dev-only. Regenerates fixtures/grants-gov-extract/00-extract.zip.b64 — a real ZIP archive
// containing one XML member, small enough to commit and review. The production file is 77.85 MB.
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

const name = Buffer.from('GrantsDBExtract20260802v2.xml', 'ascii');
const raw = Buffer.from(XML, 'utf8');
const deflated = deflateRawSync(raw, { level: 9 });
const crc = crc32(raw);

const local = Buffer.alloc(30);
local.writeUInt32LE(0x04034b50, 0);
local.writeUInt16LE(20, 4);           // version needed
local.writeUInt16LE(0, 6);            // flags
local.writeUInt16LE(8, 8);            // method: deflate
local.writeUInt16LE(0, 10);           // time
local.writeUInt16LE(0x2101, 12);      // date (fixed, so the file is byte-deterministic)
local.writeUInt32LE(crc, 14);
local.writeUInt32LE(deflated.length, 18);
local.writeUInt32LE(raw.length, 22);
local.writeUInt16LE(name.length, 26);
local.writeUInt16LE(0, 28);

const central = Buffer.alloc(46);
central.writeUInt32LE(0x02014b50, 0);
central.writeUInt16LE(20, 4);
central.writeUInt16LE(20, 6);
central.writeUInt16LE(0, 8);
central.writeUInt16LE(8, 10);
central.writeUInt16LE(0, 12);
central.writeUInt16LE(0x2101, 14);
central.writeUInt32LE(crc, 16);
central.writeUInt32LE(deflated.length, 20);
central.writeUInt32LE(raw.length, 24);
central.writeUInt16LE(name.length, 28);
central.writeUInt32LE(0, 42);         // local header offset

const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(1, 8);
end.writeUInt16LE(1, 10);
end.writeUInt32LE(central.length + name.length, 12);
end.writeUInt32LE(local.length + name.length + deflated.length, 16);

const zip = Buffer.concat([local, name, deflated, central, name, end]);
mkdirSync('fixtures/grants-gov-extract', { recursive: true });
writeFileSync('fixtures/grants-gov-extract/00-extract.zip.b64', zip.toString('base64'));
console.log(`wrote ${zip.length} bytes of ZIP as base64`);
