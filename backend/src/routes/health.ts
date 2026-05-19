import { Router } from 'express';

import { prisma } from '../db.js';
import { logger } from '../lib/logger.js';

const router = Router();

router.get('/', (_req, res) => {
  res.status(200).json({ status: 'ok' });
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
