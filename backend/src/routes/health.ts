import { Router } from 'express';

import { prisma } from '../db.js';
import { env } from '../env.js';
import { logger } from '../lib/logger.js';

const router = Router();

router.get('/', (_req, res) => {
  // `killSwitch` is the public signal the frontend banner polls (mounted at
  // both `/healthz` and `/api/health`; the latter is proxied same-origin by
  // nginx in prod). It reports degrade mode — new builds paused, existing
  // apps still serving.
  res.status(200).json({ status: 'ok', killSwitch: env.KILL_SWITCH });
});

router.get('/db', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    logger.error({ err }, 'healthz/db failed');
    res.status(500).json({ status: 'down' });
  }
});

export default router;
