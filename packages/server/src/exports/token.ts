/**
 * THE CREDENTIAL FOR A SESSION-LESS PUBLIC URL.
 *
 * `/calendar/:token` is fetched by a calendar client — a phone, Outlook, Google Calendar — that
 * cannot log in, cannot send a cookie and cannot be prompted for anything. The token in the path
 * IS the whole authentication, which changes what this file has to be good at:
 *
 *   1. IT MUST BE UNGUESSABLE. 32 random bytes from `randomBytes` (the CSPRNG, never `Math.random`)
 *      is 256 bits. Base64url gives 43 URL-safe characters with no padding, so the whole token
 *      survives a path segment, a QR code and an email client's line wrapping unaltered.
 *   2. IT MUST NOT SURVIVE A DATABASE DUMP. Only `hashIcsToken`'s digest is persisted, so a copy
 *      of `grantspotter.sqlite` — a backup, a support attachment, the JSON export this same
 *      package writes — does not hand out every subscriber's feed URL. The plaintext exists once,
 *      in the response to the POST that created it, and is never recoverable afterwards; the GET
 *      route therefore cannot show it again, which is a property of this design and not an
 *      oversight.
 *
 * A SHA-256 with no salt and no key stretching is the right primitive here and a wrong one for a
 * password. The input is 256 bits of uniform randomness this process generated, so there is no
 * dictionary to attack and nothing to precompute against: work factors buy nothing, and a digest
 * fast enough to run on every feed fetch is what keeps a subscription cheap.
 */
import { createHash, randomBytes } from 'node:crypto';

/** 32 random bytes, base64url encoded: 43 URL-safe characters, no padding. */
export function newIcsToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Only the hash is persisted, so a database dump does not leak anyone's feed URL. */
export function hashIcsToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
