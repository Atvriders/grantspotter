import { createHash } from 'node:crypto';

export function slugId(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * Deterministic and stable: the same externalKey from the same source always yields the same
 * Program id, which is what lets diffPrograms match last night's record to tonight's.
 */
export function programIdFor(sourceId: string, externalKey: string): string {
  const digest = createHash('sha256').update(`${sourceId}|${externalKey}`).digest('hex').slice(0, 8);
  return `${sourceId}--${slugId(externalKey)}--${digest}`;
}
