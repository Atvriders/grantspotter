import type Database from 'better-sqlite3';
import type { ChangeKind, DateWindow, Program, Recurrence } from '@grantspotter/core';
import { parseObservedWindow, parseRecurrence } from '@grantspotter/core';
import { BLOCKED_HOSTS } from '../fetcher/blocklist.js';
import { createProgramRepo } from '../db/repositories/programs.js';
import { isDoNotPublish } from '../normalize/index.js';

/** PLAN-LOCAL to Plan 3. */
export interface NotificationRow {
  id: string;
  userId: string;
  changeEventId: string | null;
  /** The source that raised the event; a source-scoped alarm has no programId. */
  sourceId: string | null;
  programId: string | null;
  programName: string | null;
  kind: ChangeKind;
  title: string;
  body: string;
  fieldPath: string | null;
  before: string | null;
  after: string | null;
  createdAt: string;
  readAt: string | null;
}

/** PLAN-LOCAL to Plan 3. What an operator reads to tell silence from breakage. */
export interface FanoutHealth {
  /** Change events the drain has never processed. Non-zero means it is not running. */
  pendingEvents: number;
  fannedOutEvents: number;
  /** Events that reached nobody at all — the shape a broken-but-unwatched source has. */
  zeroRecipientEvents: number;
  /**
   * Both numbers, because they answer different questions. A real crawl ledgers
   * 553 `not_publishable` events a night affecting 0 watchers (the suppressed
   * corpus re-diffs as `new` every night, since those records are stored but
   * never published), and one `duplicate_unread` event affecting 5. Reporting
   * only the watcher total would render the first case as a silent zero.
   */
  suppressed: Array<{ reason: string; events: number; watchers: number }>;
  lastFanoutAt: string | null;
  notifications: { total: number; unread: number };
}

const TITLES: Record<ChangeKind, string> = {
  new: 'New opportunity',
  deadline_changed: 'Deadline changed',
  amount_changed: 'Award amount changed',
  eligibility_changed: 'Eligibility changed',
  status_changed: 'Status changed',
  vanished: 'Record vanished from its source',
  parse_yield_dropped: 'Parser yield dropped',
};

/**
 * What to do about it. A notification a user cannot act on is worse than none,
 * so every kind ends in an instruction, and the instruction for a source-level
 * alarm is aimed at the watcher rather than at an operator: what it means to
 * them is that anything they watch from that source may now be stale.
 */
const ADVICE: Record<ChangeKind, string> = {
  new: 'Check the funder’s own page before you rely on it.',
  deadline_changed: 'Check the funder’s own page before you rely on either date.',
  amount_changed: 'Check the funder’s own page before you rely on either figure.',
  eligibility_changed: 'Re-check the eligibility section before you apply.',
  status_changed: 'Check the funder’s own page before you rely on it.',
  vanished: 'The record is kept, unverified, until someone checks the page.',
  parse_yield_dropped:
    'Our reader for this source returned less than it should, so anything you watch from it may now be stale. Check the funder’s page yourself.',
};

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

const BODY_LIMIT = 240;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * farweb.org was taken over between 2025-10-17 and 2026-02-10 and now 301s to a
 * gambling site; the corpus keeps a `safety_warning` record for it ON PURPOSE,
 * and that record is publishable, so it can be starred and it can change. The
 * fetcher's blocklist stops us READING those hosts; this stops us REPEATING one
 * to a student. The host is not echoed even as plain text, because a digest
 * that linkifies bare hostnames would turn it back into a link.
 *
 * BLOCKED_HOSTS is imported, never restated: the blocklist is deliberately not
 * configurable, and a second copy of it here is a second thing to forget.
 */
const BLOCKED_HOST_PATTERN = new RegExp(
  `(?:https?:\\/\\/)?(?:[a-z0-9-]+\\.)*(?:${BLOCKED_HOSTS.map(escapeRegExp).join('|')})(?:\\/[^\\s"'<>)\\]]*)?`,
  'gi',
);

const BLOCKED_REPLACEMENT = '[link withheld: that domain is blocklisted for safety]';

export function redactBlockedLinks(text: string): string {
  return text.replace(BLOCKED_HOST_PATTERN, BLOCKED_REPLACEMENT);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function monthDay(md: { month: number; day: number }): string {
  return `${MONTHS[md.month - 1] ?? md.month} ${md.day}`;
}

/**
 * The CLOSE first, always. These phrases are read inside "Changed from … to …",
 * so a window rendered as "Oct 30 to Dec 30" would put three "to"s in one
 * sentence and leave the reader parsing the grammar instead of the date — and
 * the close is the only half of a window anyone acts on.
 */
function projected(text: string, timezone: string, opens?: string): string {
  const qualifier = opens === undefined
    ? `projected from a recurrence rule, ${timezone}`
    : `opens ${opens}; projected from a recurrence rule, ${timezone}`;
  return `${text} (${qualifier})`;
}

function recurrenceText(rec: Recurrence): string | null {
  if (rec.kind === 'annual_window') {
    return projected(
      `closes ${monthDay(rec.window.close)}`,
      rec.timezone,
      monthDay(rec.window.open),
    );
  }
  if (rec.kind === 'n_fixed_dates') {
    return projected(`closes ${rec.dates.map(monthDay).join(', ')}`, rec.timezone);
  }
  if (rec.kind === 'n_fixed_windows') {
    return projected(
      `closes ${rec.windows.map((w: DateWindow) => monthDay(w.close)).join(', ')}`,
      rec.timezone,
      rec.windows.map((w: DateWindow) => monthDay(w.open)).join(', '),
    );
  }
  return null;
}

/**
 * A `DeadlineSpec` as a date, not as the JSON the differ stored.
 *
 * This is the whole point of the fan-out. `diffPrograms` puts the entire spec —
 * `{kind, source, note}`, note carrying a `RECUR` directive — in before/after,
 * so the naive rendering of spec §11.2's own example ("ARRL moved the
 * scholarship close from Jan 31 to Dec 30") is two walls of JSON with a machine
 * directive inside them.
 *
 * A window the funder PUBLISHED and a window we PROJECTED from a recurrence
 * rule are not the same claim — that is the `isEstimated` distinction the
 * calendar draws, and `observedCycles` / `expandCycles` are separate functions
 * for the same reason — so the rendering says which one moved. The two readers
 * are core's, never re-implemented here.
 */
function deadlineText(spec: Record<string, unknown>): string {
  const note = typeof spec.note === 'string' ? spec.note : '';
  const observed = note === '' ? undefined : parseObservedWindow(note);
  if (observed !== undefined) {
    const close = observed.closesAt === undefined ? null : `closes ${observed.closesAt}`;
    const open = observed.opensAt === undefined ? null : `opens ${observed.opensAt}`;
    const head = close ?? open ?? '';
    const tail = close !== null && open !== null ? `${open}; published by the funder` : 'published by the funder';
    return `${head} (${tail})`;
  }

  let recurrence: Recurrence = { kind: 'none' };
  try {
    if (note !== '') recurrence = parseRecurrence(note);
  } catch {
    // A malformed RECUR directive is Plan 2's alarm to raise, not a reason to
    // fail a digest: fall through to the spec's own kind below.
    recurrence = { kind: 'none' };
  }
  const text = recurrenceText(recurrence);
  if (text !== null) return text;

  const source = isRecord(spec.source) ? spec.source : undefined;
  if (source?.kind === 'inherited' && typeof source.fromProgramId === 'string') {
    return `inherited from ${source.fromProgramId}`;
  }
  return typeof spec.kind === 'string' ? spec.kind.replace(/_/g, ' ') : 'an unstated deadline';
}

function amountText(spec: Record<string, unknown>): string {
  if (typeof spec.amountRaw === 'string' && spec.amountRaw.trim() !== '') return spec.amountRaw;
  const min = typeof spec.amountMin === 'number' ? spec.amountMin : null;
  const max = typeof spec.amountMax === 'number' ? spec.amountMax : null;
  if (min !== null && max !== null) return min === max ? `$${min}` : `$${min} to $${max}`;
  if (max !== null) return `up to $${max}`;
  if (min !== null) return `from $${min}`;
  return typeof spec.instrument === 'string' ? spec.instrument.replace(/_/g, ' ') : 'an unstated amount';
}

function constraintsText(list: unknown[]): string {
  const texts = list
    .map((c) => (isRecord(c) && typeof c.rawText === 'string' ? c.rawText : null))
    .filter((t): t is string => t !== null);
  const label = `${list.length} eligibility rule${list.length === 1 ? '' : 's'}`;
  if (texts.length === 0) return label;
  const shown = texts.slice(0, 2).map((t) => `“${t.length > 80 ? `${t.slice(0, 79)}…` : t}”`);
  return `${label} (${shown.join('; ')}${texts.length > shown.length ? '; …' : ''})`;
}

function truncate(text: string, limit = BODY_LIMIT): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/**
 * One side of a change, as a phrase. Every shape here is one a real crawl
 * writes: `diffPrograms` stores whole `DeadlineSpec` / `AmountSpec` /
 * `Constraint[]` / `Program` values, and `detectYieldDrop` stores
 * `{expectedMinRecords}` / `{parsedCount}`. Anything unrecognised falls back to
 * truncated JSON, which is ugly on purpose — it is a shape nobody wrote a
 * sentence for yet, and it should look like it.
 */
export function summarizeChangeValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  if (Array.isArray(value)) {
    if (value.length > 0 && value.every((c) => isRecord(c) && 'rawText' in c)) {
      return constraintsText(value);
    }
    return truncate(JSON.stringify(value));
  }

  if (isRecord(value)) {
    if (typeof value.expectedMinRecords === 'number') {
      return `at least ${value.expectedMinRecords} records`;
    }
    if (typeof value.parsedCount === 'number') return `${value.parsedCount} records`;
    if (typeof value.name === 'string' && typeof value.id === 'string') return value.name;
    if ('note' in value && 'source' in value && 'kind' in value) return deadlineText(value);
    if ('instrument' in value) return amountText(value);
    return truncate(JSON.stringify(value));
  }

  return truncate(String(value));
}

/**
 * Turn a ChangeEvent into a sentence. The deadline case is the one the product
 * exists for: "ARRL moved the scholarship close from Jan 31 to Dec 30".
 */
export function describeChange(
  kind: ChangeKind,
  before: unknown,
  after: unknown,
  fieldPath: string | null,
  programName: string | null,
): { title: string; body: string } {
  const base = TITLES[kind];
  const title = redactBlockedLinks(programName ? `${base}: ${programName}` : base);
  const b = summarizeChangeValue(before);
  const a = summarizeChangeValue(after);
  const where = fieldPath ? ` (${fieldPath})` : '';

  let sentence: string;
  if (b !== null && a !== null) sentence = `Changed from ${b} to ${a}${where}.`;
  else if (a !== null) sentence = `Now ${a}${where}.`;
  else if (b !== null) sentence = `Was ${b}${where}; the source no longer carries it.`;
  else sentence = `Detected on the source${where}.`;

  return { title, body: redactBlockedLinks(`${sentence} ${ADVICE[kind]}`) };
}

interface PendingEvent {
  id: string;
  source_id: string;
  program_id: string | null;
  kind: ChangeKind;
  before_json: string | null;
  after_json: string | null;
  field_path: string | null;
}

interface WatchRow {
  user_id: string;
  notify_changes: number;
}

/** Users who asked to hear about this, and users who starred it but muted it. */
function splitWatchers(rows: WatchRow[]): { subscribers: string[]; muted: string[] } {
  const subscribed = new Set<string>();
  const all = new Set<string>();
  for (const row of rows) {
    all.add(row.user_id);
    if (row.notify_changes === 1) subscribed.add(row.user_id);
  }
  return {
    subscribers: [...subscribed].sort(),
    muted: [...all].filter((u) => !subscribed.has(u)).sort(),
  };
}

function parseJson(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    // A row written by something other than insertChangeEvents. Keep the text
    // rather than dropping the notification: a value we cannot parse is still a
    // value the watcher is entitled to see.
    return value;
  }
}

/** The `Program` a `new` / `vanished` event carries, if it carries one. */
function programFromPayload(value: unknown): Pick<Program, 'name' | 'tags'> | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.name !== 'string' || !Array.isArray(value.tags)) return undefined;
  return { name: value.name, tags: value.tags.filter((t): t is string => typeof t === 'string') };
}

const REASON_RANK = ['not_publishable', 'duplicate_unread', 'muted'];

function dominantReason(reasons: string[]): string | null {
  for (const candidate of REASON_RANK) if (reasons.includes(candidate)) return candidate;
  return null;
}

/**
 * Fan every not-yet-processed change event out to the users who watch it, and
 * return the number of notifications created.
 *
 * A DRAIN, NOT A CALLBACK. Nothing that writes a change event — the nightly
 * crawl, "Verify now", an Inbox approval — has to know notifications exist;
 * they all just write `change_events`, and this catches up from anywhere, any
 * number of times, because `change_event_fanout` is the idempotency ledger.
 *
 * Program-scoped events go to that program's watchers. Source-scoped ones (a
 * parse-yield drop) go to everyone watching any program that source supplies,
 * via `programs.source_id` — Plan 1's ingest identity (RESOLUTIONS R9), the
 * same key `listProgramsBySource` and the differ reconcile on, so a source's
 * membership is read from one place rather than two.
 *
 * WHAT IS DELIBERATELY NOT DELIVERED, and why it is still visible. The nightly
 * crawl re-raises a broken source's alarm every single night with a fresh event
 * id; three unread copies of the same sentence is how a queue teaches its user
 * to clear without reading (the nsf-funding-rss lesson: 45 of 46 items scored
 * below threshold, so the whole queue got ignored). So a repeat of an alarm the
 * user has not read yet is not delivered, a muted star is honoured, and a
 * record the product refuses to publish is not announced. None of that touches
 * `change_events`: every event still lands, every event is still ledgered here
 * with a recipient count and a suppression reason, and `fanoutHealth` reads
 * them back. Suppressing noise must never cost the ability to notice a source
 * silently breaking.
 */
export function drainChangeEvents(db: Database.Database, nowISO: string): number {
  const pending = db
    .prepare(
      `SELECT ce.id, ce.source_id, ce.program_id, ce.kind,
              ce.before_json, ce.after_json, ce.field_path
         FROM change_events ce
         LEFT JOIN change_event_fanout f ON f.change_event_id = ce.id
        WHERE f.change_event_id IS NULL
        ORDER BY ce.detected_at, ce.id`,
    )
    .all() as PendingEvent[];

  if (pending.length === 0) return 0;

  // `watchersOfProgram` in `watchRouter.ts` answers the same question for the
  // watchlist page and deliberately ignores `notify_changes`: that page must
  // show every star. The digest must not — `notify_changes = 0` is a user
  // saying "keep this on my list, stop telling me about it", and until now
  // Plan 1's column had no reader anywhere in this repository.
  const watchersOfProgram = db.prepare(
    'SELECT user_id, notify_changes FROM watches WHERE program_id = ?',
  );
  const watchersOfSource = db.prepare(
    `SELECT w.user_id, w.notify_changes
       FROM watches w
       JOIN programs p ON p.id = w.program_id
      WHERE p.source_id = ?`,
  );
  /**
   * DOMAIN FACT 5, and the largest single gap in the fan-out as briefed. 111 of
   * the ARRL catalog's entries carry `deadline.source: {kind:'inherited',
   * fromProgramId}` and ride ONE cycle. Measured against the committed
   * fixtures, all 111 inherit and NONE of them carries a RECUR rule of its own —
   * so when ARRL moves the close from Jan 31 to Dec 30, `diffPrograms` raises
   * exactly ONE `deadline_changed` event, on the owner, and the 111 records that
   * actually move raise nothing at all. Fanning out to the owner's watchers
   * alone would deliver spec §11.2's headline event to almost nobody who needs
   * it. Riders are resolved from the stored spec, the same relation
   * `resolveDeadlineOwner` reads, so there is no second definition of "rides
   * this cycle".
   */
  const ridersOf = db.prepare(
    `SELECT id FROM programs WHERE json_extract(deadline, '$.source.fromProgramId') = ?`,
  );
  const sourceLabel = db.prepare('SELECT label FROM sources WHERE id = ?');
  const duplicateUnread = db.prepare(
    `SELECT 1 FROM notifications
      WHERE user_id = @user_id
        AND kind = @kind
        AND read_at IS NULL
        AND IFNULL(program_id, '') = IFNULL(@program_id, '')
        AND IFNULL(source_id, '') = IFNULL(@source_id, '')
        AND IFNULL(before_text, '') = IFNULL(@before_text, '')
        AND IFNULL(after_text, '') = IFNULL(@after_text, '')
      LIMIT 1`,
  );
  const insertNotification = db.prepare(
    `INSERT INTO notifications
       (id, user_id, change_event_id, source_id, program_id, program_name, kind, title, body,
        field_path, before_text, after_text, created_at, read_at)
     VALUES (@id, @user_id, @change_event_id, @source_id, @program_id, @program_name, @kind,
             @title, @body, @field_path, @before_text, @after_text, @created_at, NULL)`,
  );
  const markFannedOut = db.prepare(
    `INSERT OR IGNORE INTO change_event_fanout
       (change_event_id, fanned_out_at, recipient_count, suppressed_count, suppressed_reason)
     VALUES (?, ?, ?, ?, ?)`,
  );

  const programs = createProgramRepo(db);
  const cache = new Map<string, Program | undefined>();
  const loadProgram = (id: string): Program | undefined => {
    if (!cache.has(id)) cache.set(id, programs.get(id));
    return cache.get(id);
  };

  let created = 0;

  const run = db.transaction(() => {
    for (const ce of pending) {
      // A moved shared cycle moves every programme that rides it, so those
      // programmes' watchers are recipients too — see `ridersOf`. Only the
      // deadline propagates: an inheriting record takes its CYCLE from the
      // owner and nothing else, so an amount or eligibility change on the owner
      // is not news for a rider, and announcing it under the owner's name would
      // be a notification about a programme the reader never starred.
      const riders =
        ce.program_id !== null && ce.kind === 'deadline_changed'
          ? (ridersOf.all(ce.program_id) as Array<{ id: string }>).map((r) => r.id)
          : [];

      let rows: WatchRow[];
      if (ce.program_id === null) {
        rows = watchersOfSource.all(ce.source_id) as WatchRow[];
      } else if (riders.length === 0) {
        rows = watchersOfProgram.all(ce.program_id) as WatchRow[];
      } else {
        const ids = [ce.program_id, ...riders];
        rows = db
          .prepare(
            `SELECT user_id, notify_changes FROM watches
              WHERE program_id IN (${ids.map(() => '?').join(', ')})`,
          )
          .all(...ids) as WatchRow[];
      }
      const { subscribers, muted } = splitWatchers(rows);

      const before = parseJson(ce.before_json);
      const after = parseJson(ce.after_json);
      const program = ce.program_id === null ? undefined : loadProgram(ce.program_id);
      // RESOLUTIONS R26: an approved `vanished` event deletes the program row,
      // so the record this event is about may already be gone. Its name — and
      // its suppression tag — then live only in the event payload.
      const carried = programFromPayload(before) ?? programFromPayload(after);
      const record = program ?? carried;
      // A source-scoped alarm has no programme to name, so it names the source:
      // "Parser yield dropped" alone does not tell the reader WHICH of their
      // watched sources went quiet, which is the one thing they need to act.
      const sourceRow = sourceLabel.get(ce.source_id) as { label: string } | undefined;
      const programName =
        record?.name ?? (ce.program_id === null ? sourceRow?.label ?? ce.source_id : null);

      // ~553 of the corpus's records are stored but suppressed (past awards,
      // the crosscheck table). Browse, the review queue and the approve path all
      // drop them through this one shared predicate; announcing one would open a
      // page the product refuses to show.
      if (record !== undefined && isDoNotPublish(record)) {
        markFannedOut.run(ce.id, nowISO, 0, subscribers.length + muted.length, 'not_publishable');
        continue;
      }

      const described = describeChange(ce.kind, before, after, ce.field_path, programName);
      const { title } = described;
      const body =
        riders.length === 0
          ? described.body
          : `${described.body} ${riders.length} other ${
              riders.length === 1 ? 'programme inherits' : 'programmes inherit'
            } this cycle and move with it.`;
      const beforeText = redactNullable(summarizeChangeValue(before));
      const afterText = redactNullable(summarizeChangeValue(after));

      let delivered = 0;
      const reasons: string[] = muted.length > 0 ? ['muted'] : [];
      let suppressed = muted.length;

      for (const userId of subscribers) {
        const isRepeat = duplicateUnread.get({
          user_id: userId,
          kind: ce.kind,
          program_id: ce.program_id,
          source_id: ce.source_id,
          before_text: beforeText,
          after_text: afterText,
        });
        if (isRepeat !== undefined) {
          suppressed += 1;
          reasons.push('duplicate_unread');
          continue;
        }
        insertNotification.run({
          id: `${ce.id}:${userId}`,
          user_id: userId,
          change_event_id: ce.id,
          source_id: ce.source_id,
          program_id: ce.program_id,
          program_name: programName,
          kind: ce.kind,
          title,
          body,
          field_path: ce.field_path,
          before_text: beforeText,
          after_text: afterText,
          created_at: nowISO,
        });
        delivered += 1;
        created += 1;
      }

      markFannedOut.run(ce.id, nowISO, delivered, suppressed, dominantReason(reasons));
    }
  });

  run();
  return created;
}

function redactNullable(value: string | null): string | null {
  return value === null ? null : redactBlockedLinks(value);
}

/**
 * The reader that keeps the ledger honest. An empty digest is ambiguous on its
 * own; these counters say which kind of empty it is.
 */
export function fanoutHealth(db: Database.Database): FanoutHealth {
  const one = (sql: string): number =>
    (db.prepare(sql).get() as { n: number }).n;

  const suppressed = db
    .prepare(
      `SELECT suppressed_reason AS reason,
              COUNT(*) AS events,
              SUM(suppressed_count) AS watchers
         FROM change_event_fanout
        WHERE suppressed_reason IS NOT NULL
        GROUP BY suppressed_reason
        ORDER BY suppressed_reason`,
    )
    .all() as Array<{ reason: string; events: number; watchers: number }>;

  const last = db
    .prepare('SELECT MAX(fanned_out_at) AS at FROM change_event_fanout')
    .get() as { at: string | null };

  return {
    pendingEvents: one(
      `SELECT COUNT(*) AS n FROM change_events ce
         LEFT JOIN change_event_fanout f ON f.change_event_id = ce.id
        WHERE f.change_event_id IS NULL`,
    ),
    fannedOutEvents: one('SELECT COUNT(*) AS n FROM change_event_fanout'),
    zeroRecipientEvents: one(
      'SELECT COUNT(*) AS n FROM change_event_fanout WHERE recipient_count = 0',
    ),
    suppressed,
    lastFanoutAt: last.at,
    notifications: {
      total: one('SELECT COUNT(*) AS n FROM notifications'),
      unread: one('SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL'),
    },
  };
}
