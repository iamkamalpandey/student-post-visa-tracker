import { Router } from 'express';
import { prisma, isRlsRoleVerified, assertRuntimeRoleRespectsRls } from '../../config/db.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { getRedisClient } from '../../shared/redisClient.js';
import { dbUp, redisUp } from '../../config/metrics.js';

export const healthRouter: Router = Router();

healthRouter.get('/livez', (_req, res) => {
  res.json({ status: 'ok' });
});

healthRouter.get('/readyz', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbUp.set(1);

    // SVT-SEC-2026-08 — do not report ready until tenant isolation is PROVEN.
    //
    // assertRuntimeRoleRespectsRls() runs at boot and exits the process when it
    // finds a superuser/BYPASSRLS DATABASE_URL in production. But when its probe
    // THROWS (a DB blip during a deploy, a failover) it deliberately does not
    // crash — and it used to simply skip, so the instance served indefinitely
    // with the check never performed. If DATABASE_URL was misconfigured to the
    // admin role, RLS would be off for the whole app with no other symptom.
    //
    // Gating readiness on it is the right lever. The DB is demonstrably up by
    // this point, so retrying here is cheap and will succeed; if the role turns
    // out to be privileged the assert exits the process, and if it still cannot
    // be proven the instance stays un-ready and never receives traffic while the
    // platform keeps the previous version serving. A blip now delays readiness
    // instead of silently disabling the control that makes this app safe to run
    // multi-tenant.
    if (env.NODE_ENV === 'production' && !isRlsRoleVerified()) {
      await assertRuntimeRoleRespectsRls();
      if (!isRlsRoleVerified()) {
        logger.error('readyz: runtime DB role not verified as RLS-enforced — refusing ready');
        res.status(503).json({ status: 'not_ready', db: 'ok', rls_role: 'unverified' });
        return;
      }
    }
    const redis = await getRedisClient();
    const redisConfigured = Boolean(process.env.REDIS_URL);
    const redisStatus = redis ? 'connected' : (redisConfigured ? 'unavailable' : 'not_configured');
    // SVT-OBS-2026-06 — reflect reachability in the gauges every probe so a
    // Prometheus alert on `db_up == 0` / `redis_up == 0` actually has a series
    // to fire on. An unconfigured Redis (a valid single-node topology) stays 1
    // so the alert doesn't page on an intentional absence.
    redisUp.set(redis ? 1 : redisConfigured ? 0 : 1);
    res.json({ status: 'ready', db: 'ok', redis: redisStatus });
  } catch (err) {
    dbUp.set(0);
    // SVT-SEC-2026-08 — do NOT echo the driver error to an unauthenticated
    // caller. Prisma/pg connection failures embed the database host, port, role
    // and sometimes the database name, and this route is public (mounted before
    // `authenticate` in app.ts) and is about to become the platform health
    // probe, so it is reachable from anywhere. Anyone who could reach it could
    // read the infrastructure topology simply by catching the app mid-outage —
    // the moment it is least able to defend itself.
    //
    // The detail still goes to the logs, where operators need it; the response
    // carries only the fact that the service is not ready, which is the only
    // thing a health probe consumes.
    logger.error({ err }, 'readyz: dependency check failed');
    res.status(503).json({
      status: 'not_ready',
      db: 'error',
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
