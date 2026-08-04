import { Router } from 'express';
import type { RouterDeps } from './deps.js';
import { AppError } from './errors.js';
import {
  assertSafeWebhookUrl,
  loadChannel,
  saveChannel,
  loadDeliveryHealth,
  deliverForUser,
  type ChannelConfig,
  type DeliverableNotification,
} from './channels.js';

/**
 * An ntfy topic becomes a path segment, so anything that can change the shape
 * of the URL has to be refused here rather than escaped later. Matches ntfy's
 * own topic vocabulary.
 */
const NTFY_TOPIC = /^[A-Za-z0-9_-]{1,64}$/;

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new AppError('validation_failed', `${field} must be a string.`, { field });
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function safeUrlOrThrow(value: string | null, field: string): string | null {
  if (value === null) return null;
  try {
    assertSafeWebhookUrl(value);
  } catch (err) {
    // The rejection reason IS the user-facing message: "webhook URLs must use
    // https" and "refusing a private or internal webhook host (loopback)" are
    // both things a user can act on. "unsafe_url" is not.
    throw new AppError('validation_failed', (err as Error).message, { field });
  }
  return value;
}

export function createChannelRouter(deps: RouterDeps, fetchImpl: typeof fetch = fetch): Router {
  const router = Router();

  router.get('/', deps.requireAuth, (req, res) => {
    const userId = deps.currentUser(req).id;
    // Health travels with the configuration deliberately. A user looking at an
    // empty inbox needs to be able to tell "nothing changed" from "this
    // webhook has refused every delivery since Tuesday" without leaving the
    // page where the destination is configured.
    res.json({ ...loadChannel(deps.db, userId), health: loadDeliveryHealth(deps.db, userId) });
  });

  router.put('/', deps.requireAuth, (req, res, next) => {
    const user = deps.currentUser(req);
    const body = (req.body ?? {}) as Record<string, unknown>;

    let config: ChannelConfig;
    try {
      const ntfyServer = safeUrlOrThrow(optionalString(body.ntfyServer, 'ntfyServer'), 'ntfyServer');
      const ntfyTopic = optionalString(body.ntfyTopic, 'ntfyTopic');
      if (ntfyTopic !== null && !NTFY_TOPIC.test(ntfyTopic)) {
        throw new AppError(
          'validation_failed',
          'An ntfy topic may contain letters, digits, hyphens and underscores only.',
          { field: 'ntfyTopic' },
        );
      }
      // Half a configuration delivers nowhere, and would look configured.
      if ((ntfyServer === null) !== (ntfyTopic === null)) {
        throw new AppError(
          'validation_failed',
          'ntfy needs both a server and a topic, or neither.',
          { field: ntfyServer === null ? 'ntfyServer' : 'ntfyTopic' },
        );
      }
      config = {
        inApp: body.inApp !== false,
        webhookUrl: safeUrlOrThrow(optionalString(body.webhookUrl, 'webhookUrl'), 'webhookUrl'),
        ntfyServer,
        ntfyTopic,
      };
    } catch (err) {
      // Nothing is written on a rejected body: the previously saved (and
      // previously validated) configuration survives intact.
      next(err);
      return;
    }

    saveChannel(deps.db, user.id, config, deps.now());
    res.json(config);
  });

  /**
   * Send one test notification through every configured external channel.
   *
   * A user cannot act on a notification that never arrives, and the arrival is
   * the part GrantSpotter cannot see — so this exists to make the destination
   * prove itself at configuration time rather than at 3am on the night a
   * deadline actually moves. It adds no SSRF surface: it POSTs to the exact URL
   * `PUT /` already validated and stored, revalidated again on the way out, and
   * it returns only `{channel, ok, status?, error?}` — never a response body,
   * never a response header.
   */
  router.post('/test', deps.requireAuth, (req, res, next) => {
    const userId = deps.currentUser(req).id;
    const config = loadChannel(deps.db, userId);
    if (config.webhookUrl === null && config.ntfyServer === null) {
      next(
        new AppError(
          'conflict',
          'No external channel is configured, so there is nothing to test. The in-app digest is always on.',
        ),
      );
      return;
    }

    const now = deps.now();
    const probe: DeliverableNotification = {
      kind: 'new',
      title: 'GrantSpotter test notification',
      body:
        'This is a test delivery from GrantSpotter. If you are reading it, this channel works. ' +
        'Real notifications name the program and the field that changed.',
      programId: null,
      programName: null,
      fieldPath: null,
      before: null,
      after: null,
      createdAt: now,
    };

    // A failed delivery is DATA, not a 500: the user's endpoint being down is
    // not GrantSpotter erroring, and a 500 here would hide which channel failed
    // and why. The same outcome is written to health, so it survives the page.
    deliverForUser(deps.db, userId, probe, now, fetchImpl)
      .then((results) => {
        res.json({ results });
      })
      .catch(next);
  });

  return router;
}
