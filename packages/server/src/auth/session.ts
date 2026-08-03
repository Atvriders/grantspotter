import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { CookieOptions, Request } from 'express';

export const SESSION_COOKIE = 'gs_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** 32 bytes of entropy. The raw value exists only in the cookie. */
export function newSessionId(): string {
  return randomBytes(32).toString('base64url');
}

/** What is stored in the sessions table, so a database leak yields no live sessions. */
export function sessionIdHash(rawId: string): string {
  return createHash('sha256').update(rawId, 'utf8').digest('hex');
}

function sign(rawId: string, secret: string): string {
  return createHmac('sha256', secret).update(rawId).digest('base64url');
}

export function signSessionCookie(rawId: string, secret: string): string {
  return `${rawId}.${sign(rawId, secret)}`;
}

/** Returns the raw session id, or null if the value is forged or malformed. */
export function verifySessionCookie(value: string, secret: string): string | null {
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;
  const rawId = value.slice(0, dot);
  const provided = Buffer.from(value.slice(dot + 1));
  const expected = Buffer.from(sign(rawId, secret));
  if (provided.length !== expected.length) return null;
  return timingSafeEqual(provided, expected) ? rawId : null;
}

export function sessionCookieOptions(req: Request, maxAgeMs: number = SESSION_TTL_MS): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    // `trust proxy` is set in createApp, so req.secure reflects the client's
    // scheme through a reverse proxy rather than the internal hop.
    secure: req.secure,
    path: '/',
    maxAge: maxAgeMs,
  };
}
