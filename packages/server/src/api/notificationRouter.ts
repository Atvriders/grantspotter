import { Router } from 'express';
import type { ChangeKind } from '@grantspotter/core';
import type { RouterDeps } from './deps.js';
import { AppError } from './errors.js';
import { drainChangeEvents, fanoutHealth, type NotificationRow } from './notify.js';

interface NotificationDbRow {
  id: string;
  user_id: string;
  change_event_id: string | null;
  source_id: string | null;
  program_id: string | null;
  program_name: string | null;
  kind: string;
  title: string;
  body: string;
  field_path: string | null;
  before_text: string | null;
  after_text: string | null;
  created_at: string;
  read_at: string | null;
}

export function createNotificationRouter(deps: RouterDeps): Router {
  const router = Router();

  /**
   * Fan-out health, admin only. Without it, "your digest is empty" and "the
   * drain has not run since Tuesday" and "every alarm we raised reached nobody"
   * are the same screen. This is the reader for `change_event_fanout`'s
   * counters, which is what makes suppressing repeat alarms safe.
   */
  router.get('/health', deps.requireAdmin, (_req, res) => {
    res.json(fanoutHealth(deps.db));
  });

  router.get('/', deps.requireAuth, (req, res) => {
    // Draining on read keeps the digest correct without a background worker.
    // The corpus is ~150 records, so this is a few indexed statements.
    drainChangeEvents(deps.db, deps.now());

    const user = deps.currentUser(req);
    const unreadOnly = req.query.unreadOnly === 'true';
    const rows = deps.db
      .prepare(
        `SELECT id, user_id, change_event_id, source_id, program_id, program_name, kind,
                title, body, field_path, before_text, after_text, created_at, read_at
           FROM notifications
          WHERE user_id = ? ${unreadOnly ? 'AND read_at IS NULL' : ''}
          ORDER BY created_at DESC, id DESC
          LIMIT 200`,
      )
      .all(user.id) as NotificationDbRow[];

    const unread = (
      deps.db
        .prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL')
        .get(user.id) as { n: number }
    ).n;

    const mapped: NotificationRow[] = rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      changeEventId: r.change_event_id,
      sourceId: r.source_id,
      programId: r.program_id,
      programName: r.program_name,
      kind: r.kind as ChangeKind,
      title: r.title,
      body: r.body,
      fieldPath: r.field_path,
      before: r.before_text,
      after: r.after_text,
      createdAt: r.created_at,
      readAt: r.read_at,
    }));

    res.json({ rows: mapped, unread });
  });

  router.post('/read-all', deps.requireAuth, (req, res) => {
    const user = deps.currentUser(req);
    deps.db
      .prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL')
      .run(deps.now(), user.id);
    res.status(204).end();
  });

  router.post('/:id/read', deps.requireAuth, (req, res, next) => {
    const user = deps.currentUser(req);
    const info = deps.db
      .prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?')
      .run(deps.now(), req.params.id, user.id);
    if (info.changes === 0) {
      // Deliberately not distinguishing "does not exist" from "belongs to
      // another user": the second answer would be an enumeration oracle.
      next(new AppError('not_found', 'No such notification for this user.'));
      return;
    }
    res.status(204).end();
  });

  return router;
}
