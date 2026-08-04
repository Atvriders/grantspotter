/**
 * npm run verify-sources
 *
 * LIVE check against the real sites, mirroring the arrl-calendar live-crosscheck pattern.
 * WARN-ONLY, and NEVER a CI gate: whatever the network does, it exits 0 — every source down, every
 * parser yielding nothing, still 0. The network is not a build dependency, and a maintainer on a
 * coffee-shop connection should not see a red build.
 *
 * The one exception, added 2026-08-04, is not about the network at all: a CONTACT_URL this
 * software refuses exits 2, having fetched nothing. That is an operator error in a value that was
 * about to be printed in a header for ~25 nonprofits to read, and reporting success for a run that
 * never happened would be the wrong kind of quiet.
 *
 * Its job is to say "arrl.org changed and the catalog parser now yields 4 records instead of
 * 111" so a human refreshes the fixture and fixes the parser deliberately.
 *
 *   npm run verify-sources                 # every source in the registry
 *   npm run verify-sources -- qcwa austin-arc   # just these source ids
 */
import { ConfigError, buildUserAgent, resolveContactUrl } from '../packages/server/src/config.js';
import { formatVerifyReport, verifyExitCode, verifySources } from '../packages/server/src/crawl/verify.js';
import { createFetcher } from '../packages/server/src/fetcher/index.js';
import { simplerAuthHeaders } from '../packages/server/src/federal/simplerGrants.js';

async function main(): Promise<void> {
  // The server's rule, not a second one. This used to be `process.env.CONTACT_URL?.trim() ||
  // DEFAULT_CONTACT_URL`, which skipped `loadConfig` entirely — so every value the server refuses
  // went out on the wire from here instead. Measured before the fix:
  // `CONTACT_URL='not a url' npm run verify-sources -- qcwa` fetched qcwa.org, got a live 200, and
  // sent `GrantSpotter/0.1.0 (+not a url; …)` to it. `resolveContactUrl` is the same predicate the
  // server runs, and it throws before a fetcher exists.
  //
  // Unset means "identify through the project's issue tracker". Set CONTACT_URL if the sites you
  // are about to poll should be able to reach YOU about it.
  const contactUrl = resolveContactUrl();
  const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const fetcher = createFetcher({
    userAgent: buildUserAgent(contactUrl),
    contactUrl,
    headersByHost: simplerAuthHeaders(), // {} when SIMPLER_GRANTS_API_KEY is unset
  });

  console.log('GrantSpotter live source check (warn-only, never a CI gate)\n');
  const rows = await verifySources(fetcher, only.length > 0 ? only : undefined);
  console.log(formatVerifyReport(rows));
  process.exitCode = verifyExitCode();
}

main().catch((err: unknown) => {
  // A refused CONTACT_URL is NOT the case "warn-only, never a CI gate" was written for. That rule
  // is about the network — a maintainer on a coffee-shop connection should not see a red build for
  // a site being down — and this failure never touched the network. It is an operator error in a
  // value that was about to be sent to ~25 nonprofits, so it exits non-zero and prints only the
  // message, not a stack trace nobody needs.
  if (err instanceof ConfigError) {
    console.error(`\n${err.message}\n`);
    process.exitCode = 2;
    return;
  }
  console.error(err);
  process.exitCode = verifyExitCode();
});
