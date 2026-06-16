import { Router } from 'express';
import { prisma } from '../../config/db.js';
import { getRedisClient } from '../../shared/redisClient.js';

export const healthRouter: Router = Router();

healthRouter.get('/livez', (_req, res) => {
  res.json({ status: 'ok' });
});

healthRouter.get('/readyz', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    const redis = await getRedisClient();
    const redisStatus = redis ? 'connected' : (process.env.REDIS_URL ? 'unavailable' : 'not_configured');
    res.json({ status: 'ready', db: 'ok', redis: redisStatus });
  } catch (err) {
    res.status(503).json({
      status: 'not_ready',
      db: 'error',
      detail: err instanceof Error ? err.message : 'unknown',
    });
  }
});

healthRouter.get('/version', (_req, res) => {
  res.json({
    name: 'spv-backend',
    version: process.env['npm_package_version'] ?? '0.0.0',
    node: process.version,
  });
});
