/**
 * npm run verify-sources
 *
 * LIVE check against the real sites, mirroring the arrl-calendar live-crosscheck pattern.
 * WARN-ONLY, and NEVER a CI gate: it always exits 0, even when every source is down. The
 * network is not a build dependency, and a maintainer on a coffee-shop connection should not
 * see a red build.
 *
 * Its job is to say "arrl.org changed and the catalog parser now yields 4 records instead of
 * 111" so a human refreshes the fixture and fixes the parser deliberately.
 *
 *   npm run verify-sources                 # every source in the registry
 *   npm run verify-sources -- qcwa austin-arc   # just these source ids
 */
import { buildUserAgent, DEFAULT_CONTACT_URL } from '../packages/server/src/config.js';
import { formatVerifyReport, verifyExitCode, verifySources } from '../packages/server/src/crawl/verify.js';
import { createFetcher } from '../packages/server/src/fetcher/index.js';
import { simplerAuthHeaders } from '../packages/server/src/federal/simplerGrants.js';

async function main(): Promise<void> {
  // The server's default, not a second rule: unset means "identify through the project's issue
  // tracker", and this script polls the same live sites the crawler does. Set CONTACT_URL if the
  // sites you are about to poll should be able to reach YOU about it.
  const contactUrl = process.env.CONTACT_URL?.trim() || DEFAULT_CONTACT_URL;
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
  console.error(err);
  process.exitCode = verifyExitCode();
});
