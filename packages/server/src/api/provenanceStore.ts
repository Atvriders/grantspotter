import type Database from 'better-sqlite3';
import type { RawOpportunity } from '@grantspotter/core';
import type { FieldProvenance } from './browseTypes.js';

/**
 * Raw source labels mapped onto the Program field path they populate.
 * Keys are normalized: lowercased, all whitespace collapsed and removed.
 * That collapse is what absorbs the typos observed live on arrl.org -
 * `R egion`, `License   Requirement`, `Scholarshp` - without a per-typo entry.
 *
 * DEVIATION FROM THE TASK BRIEF (2026-08-03). The brief's map covers eighteen
 * labels of a page-scraper's vocabulary. The shipped sources in `sources/` emit
 * a much wider one, and running the brief's map against the REAL captured ARRL
 * catalog put `applyUrl` — the single field the ingestion remediation was
 * about, where 76% of records once carried a url their own page contradicted —
 * under `rawOtherText`, i.e. filed as prose rather than as the apply address a
 * user is about to trust. The entries below are the keys `normalize/` and
 * `normalize/axes/` actually read, each pointed at the CONTRACT §3 field it
 * feeds; `normalize/rawFieldsContract.test.ts` is the scan that keeps that
 * vocabulary honest at the other end.
 */
const LABEL_TO_PATH: Record<string, string> = {
  awardamount: 'amount.amountRaw',
  amount: 'amount.amountRaw',
  amountraw: 'amount.amountRaw',
  benefit: 'amount.amountRaw',
  pricing: 'amount.amountRaw',
  numberofawards: 'amount.awardCountRaw',
  licenserequirement: 'constraints.license',
  license: 'constraints.license',
  region: 'constraints.geography',
  geography: 'constraints.geography',
  state: 'constraints.geography',
  counties: 'constraints.geography',
  fieldofstudy: 'constraints.field_of_study',
  institution: 'constraints.institution',
  age: 'constraints.age_stage',
  gpa: 'constraints.gpa',
  citizenship: 'constraints.citizenship',
  sponsor: 'constraints.recommendation',
  eligibility: 'constraints',
  applicanttypes: 'applicantEntities',
  deadline: 'deadline.note',
  deadlines: 'deadline.note',
  deadlinekind: 'deadline.kind',
  applicationdeadlines: 'deadline.note',
  proposalwindow: 'deadline.note',
  window: 'deadline.note',
  windows: 'deadline.note',
  opensat: 'deadline.note',
  closesat: 'deadline.note',
  date: 'deadline.note',
  pubdate: 'deadline.note',
  // The apply address, and the reason this map was widened. `normalize/index.ts`
  // reads these three in this order of preference before falling back to
  // `raw.sourceUrl`, so all three are provenance for the same displayed field.
  applyurl: 'applyUrl',
  formurl: 'applyUrl',
  detailurl: 'applyUrl',
  applynote: 'applyContact',
  summary: 'summary',
  restrictions: 'fundingRestrictions',
  sustainment: 'obligations',
  status: 'trust.status',
  other: 'rawOtherText',
};

/**
 * Keys that are THIS pipeline's bookkeeping, not a reading of the funder's page.
 * They are recorded — dropping them would hide why a record was classified as it
 * was — but under an `internal.` path, never under a CONTRACT §3 field path.
 * Filing `recordType = safety_warning` under `rawOtherText` would render our own
 * classification in the place reserved for the funder's own words, which is the
 * precise move that let a "must remain on the air for 12 months" obligation ship
 * while appearing zero times in the funder's page.
 */
const INTERNAL_LABELS: ReadonlySet<string> = new Set([
  'recordtype', 'adjacencyscore', 'adjacencyhits', 'whymanual', 'windowsource',
  'year', 'feedurl', 'scope', 'grantee', 'granteeurl',
]);

function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/\s+/g, '');
}

export function fieldPathForLabel(label: string): string {
  const key = normalizeLabel(label);
  if (INTERNAL_LABELS.has(key)) return `internal.${key}`;
  return LABEL_TO_PATH[key] ?? 'rawOtherText';
}

/**
 * Replace this source's provenance for a program with the labels in `raw`.
 * Replacement, not append: a refetch supersedes the previous reading, and the
 * old reading survives in the snapshot store, not here.
 * Returns the number of rows written.
 *
 * `raw.sourceUrl` is stored alongside every row. It is the address of the page
 * the parser read these labels off, and it is the only thing on the row a
 * reader can actually open: `snapshotId` is nullable and Task 10's verify path
 * always passes `null`. Spec §8 asks for "which source, which fetch, and the
 * raw text the value came from"; without the url, two thirds of that sentence
 * has no answer at the moment the user is looking at the value.
 */
export function recordProvenance(
  db: Database.Database,
  programId: string,
  sourceId: string,
  snapshotId: string | null,
  raw: RawOpportunity,
  nowISO: string,
): number {
  const del = db.prepare('DELETE FROM field_provenance WHERE program_id = ? AND source_id = ?');
  const ins = db.prepare(
    `INSERT INTO field_provenance
       (program_id, field_path, source_id, snapshot_id, raw_label, raw_value, fetched_at, source_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const entries = Object.entries(raw.rawFields);
  const run = db.transaction(() => {
    del.run(programId, sourceId);
    for (const [label, value] of entries) {
      ins.run(
        programId,
        fieldPathForLabel(label),
        sourceId,
        snapshotId,
        label,
        value,
        nowISO,
        raw.sourceUrl === '' ? null : raw.sourceUrl,
      );
    }
  });
  run();
  return entries.length;
}

/**
 * Read a program's provenance back, newest reading per source.
 *
 * `source_url` is COALESCEd with the snapshot's own url so a row written by a
 * caller that names a snapshot but no url still resolves to the page that was
 * fetched. The join is LEFT: a null `snapshot_id`, or a snapshot that has since
 * been pruned, yields a null url rather than dropping the row — a value with no
 * traceable page must still be visible, labelled as such, not silently missing.
 */
export function loadProvenance(db: Database.Database, programId: string): FieldProvenance[] {
  const rows = db
    .prepare(
      `SELECT fp.field_path      AS field_path,
              fp.source_id       AS source_id,
              fp.snapshot_id     AS snapshot_id,
              fp.raw_label       AS raw_label,
              fp.raw_value       AS raw_value,
              fp.fetched_at      AS fetched_at,
              COALESCE(fp.source_url, s.url) AS source_url
         FROM field_provenance fp
         LEFT JOIN snapshots s ON s.id = fp.snapshot_id
        WHERE fp.program_id = ?
        ORDER BY fp.field_path, fp.raw_label`,
    )
    .all(programId) as Array<{
      field_path: string;
      source_id: string;
      snapshot_id: string | null;
      raw_label: string;
      raw_value: string;
      fetched_at: string;
      source_url: string | null;
    }>;
  return rows.map((r) => ({
    fieldPath: r.field_path,
    sourceId: r.source_id,
    snapshotId: r.snapshot_id,
    rawLabel: r.raw_label,
    rawValue: r.raw_value,
    fetchedAt: r.fetched_at,
    sourceUrl: r.source_url,
  }));
}
