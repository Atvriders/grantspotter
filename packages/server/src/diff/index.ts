import { createHash } from 'node:crypto';
import type { ChangeEvent, ChangeKind, Program } from '@grantspotter/core';
import { hashProgram } from '@grantspotter/core';

function eventId(sourceId: string, kind: ChangeKind, key: string, nowISO: string): string {
  return createHash('sha256').update(`${sourceId}|${kind}|${key}|${nowISO}`).digest('hex').slice(0, 24);
}

function make(
  sourceId: string,
  kind: ChangeKind,
  nowISO: string,
  extra: Partial<ChangeEvent>,
): ChangeEvent {
  return {
    id: eventId(sourceId, kind, `${extra.programId ?? ''}|${extra.fieldPath ?? ''}`, nowISO),
    sourceId,
    kind,
    detectedAt: nowISO,
    ...extra,
  };
}

const stable = (value: unknown): string => JSON.stringify(value ?? null);

/**
 * Change detection hashes the PARSED ENTRIES, never the raw HTML and never response headers.
 *
 * arrl.org serves Cache-Control: nocache with NO ETag and NO Last-Modified, and every
 * <lastmod> in its sitemap is frozen at 2010 — actively misleading rather than merely absent.
 * Header-based conditional requests therefore tell us nothing, and sitemap-based detection is
 * worse than nothing. Raw-HTML hashing is equally useless: nav, footer and membership banners
 * churn independently of the catalog and would report 111 changes every night.
 *
 * hashProgram excludes TrustFields by contract, so lastVerifiedAt moving nightly is invisible.
 */
export function diffPrograms(
  previous: Program[],
  next: Program[],
  sourceId: string,
  nowISO: string,
): ChangeEvent[] {
  const before = new Map(previous.map((p) => [p.id, p]));
  const after = new Map(next.map((p) => [p.id, p]));
  const events: ChangeEvent[] = [];

  for (const [id, program] of after) {
    if (!before.has(id)) {
      events.push(make(sourceId, 'new', nowISO, { programId: id, after: program }));
    }
  }

  for (const [id, program] of before) {
    if (!after.has(id)) {
      events.push(make(sourceId, 'vanished', nowISO, { programId: id, before: program }));
    }
  }

  for (const [id, nextProgram] of after) {
    const prevProgram = before.get(id);
    if (!prevProgram) continue;
    // hashProgram excludes TrustFields by contract (see the JSDoc above and packages/core's
    // hash.ts), so a hash-equality short circuit alone would swallow a status-only change.
    // trust.status must be compared directly, not folded into the hash.
    const statusChanged = prevProgram.trust.status !== nextProgram.trust.status;
    if (!statusChanged && hashProgram(prevProgram) === hashProgram(nextProgram)) continue;

    if (stable(prevProgram.deadline) !== stable(nextProgram.deadline)) {
      events.push(
        make(sourceId, 'deadline_changed', nowISO, {
          programId: id,
          fieldPath: 'deadline',
          before: prevProgram.deadline,
          after: nextProgram.deadline,
        }),
      );
    }
    if (stable(prevProgram.amount) !== stable(nextProgram.amount)) {
      events.push(
        make(sourceId, 'amount_changed', nowISO, {
          programId: id,
          fieldPath: 'amount',
          before: prevProgram.amount,
          after: nextProgram.amount,
        }),
      );
    }
    if (stable(prevProgram.constraints) !== stable(nextProgram.constraints)) {
      events.push(
        make(sourceId, 'eligibility_changed', nowISO, {
          programId: id,
          fieldPath: 'constraints',
          before: prevProgram.constraints,
          after: nextProgram.constraints,
        }),
      );
    }
    if (prevProgram.rawOtherText !== nextProgram.rawOtherText) {
      // rawOtherText is where unmodelled eligibility lives, so it is an eligibility change.
      events.push(
        make(sourceId, 'eligibility_changed', nowISO, {
          programId: id,
          fieldPath: 'rawOtherText',
          before: prevProgram.rawOtherText,
          after: nextProgram.rawOtherText,
        }),
      );
    }
    if (statusChanged) {
      events.push(
        make(sourceId, 'status_changed', nowISO, {
          programId: id,
          fieldPath: 'trust.status',
          before: prevProgram.trust.status,
          after: nextProgram.trust.status,
        }),
      );
    }
    // A summary or tags reword deliberately emits nothing: summary is our own short excerpt,
    // and an event per reword would flood the inbox and train the reviewer to stop reading.
  }

  return events;
}

/**
 * A parser that silently starts returning zero records is the most likely way this app rots,
 * so this is a first-class alarm rather than a log line. It never fires for a source whose
 * expectedMinRecords is 0 — grants.austinhams.org legitimately shows "No opportunities
 * available" between August 1 and April 30, and an empty scrape there is the right answer.
 */
export function detectYieldDrop(
  sourceId: string,
  parsedCount: number,
  expectedMinRecords: number,
  nowISO: string,
): ChangeEvent | null {
  if (expectedMinRecords <= 0) return null;
  if (parsedCount >= expectedMinRecords) return null;
  return make(sourceId, 'parse_yield_dropped', nowISO, {
    fieldPath: 'parsedCount',
    before: { expectedMinRecords },
    after: { parsedCount },
  });
}

/** A legitimately-empty source must not report every past record as vanished. */
export function shouldSuppressVanished(nextCount: number, expectedMinRecords: number): boolean {
  return nextCount === 0 && expectedMinRecords === 0;
}
