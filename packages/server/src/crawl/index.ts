// Re-exported (not imported directly by server/src/index.ts) so the composition root's use of
// the optional AI assist (spec §9, Task 29) still only reaches ai/assist.js through crawl/ or
// review/ — the same invariant assist.test.ts enforces for every other importer.
export { createAiAssist, type AiAssist } from '../ai/assist.js';
export { contextForSource } from './context.js';
export {
  healthMessageFor,
  runCrawl,
  runSource,
  type CrawlDeps,
  type SourceRunResult,
} from './runner.js';
export {
  cronMatches,
  jitterMs,
  nextCronTime,
  startScheduler,
  type SchedulerOptions,
} from './scheduler.js';
