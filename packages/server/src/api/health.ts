import { Router } from 'express';
import { SERVER_VERSION } from '../config.js';
import type { Db } from '../db/migrate.js';
import { createProgramRepo } from '../db/repositories/programs.js';

export function createHealthRouter(db: Db): Router {
  const programs = createProgramRepo(db);
  const migrationCount = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations');

  const router = Router();
  router.get('/health', (_req, res) => {
    res.json({
      ok: true,
      name: 'grantspotter',
      version: SERVER_VERSION,
      migrations: (migrationCount.get() as { n: number }).n,
      programs: programs.count(),
      now: new Date().toISOString(),
    });
  });
  return router;
}
