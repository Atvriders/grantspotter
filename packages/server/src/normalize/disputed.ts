import type { Disputed } from '@grantspotter/core';

/**
 * Stable key for a record, independent of how its Program id was decided. RESOLUTIONS R9 means
 * the same record carries a minted id on a fresh database and the seeded id once Plan 5's corpus
 * is imported, so an id is NOT a safe key for a curated override. (sourceId, externalKey) is.
 * Pure by construction — no import, no hashing, no node: anything.
 */
export function sourceKeyOf(sourceId: string, externalKey: string): string {
  return `${sourceId}::${externalKey}`;
}

/**
 * Ships populated, per spec §8. The ARRL Club Grant cycle is the one record where three
 * researchers reached three different conclusions on 2026-08-02 and the page publishes no
 * deadline field at all. The record shows every reading with its source instead of picking one.
 */
export const DISPUTED_OVERRIDES: Readonly<Record<string, Disputed>> = Object.freeze({
  [sourceKeyOf('arrl-club-grant', 'club-grant-program')]: {
    note:
      'Three independent readings of the ARRL Club Grant cycle on 2026-08-02, and the page ' +
      'publishes no deadline field. Shown unresolved rather than guessed, because a ' +
      'confidently-displayed wrong deadline is worse than no deadline.',
    claims: [
      {
        claim:
          'Dormant: the page shows only 2024 results, with no open cycle and no application link.',
        sourceUrl: 'https://www.arrl.org/club-grant-program',
      },
      {
        claim:
          'Autumn window: historically September 7 to November 4, with 2022 wording "open until November 4".',
        sourceUrl: 'https://www.arrl.org/club-grant-program',
      },
      {
        claim:
          'February 1-28 / June 1-30 / October 1-31, which is probably a conflation with the separate ARRL Amateur Radio Grants cycle.',
        sourceUrl: 'http://www.arrl.org/amateur-radio-grants',
      },
    ],
  },
});
