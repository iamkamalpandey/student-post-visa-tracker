// SVT-SEC-2026-08 — an instance must not report ready until tenant isolation
// is proven active.
//
// `assertRuntimeRoleRespectsRls()` exits the process in production when it finds
// a superuser/BYPASSRLS DATABASE_URL, because Postgres silently ignores every
// tenant_isolation policy for such a role — tenant isolation would be OFF for
// the whole application with no other symptom.
//
// But when its probe THROWS (a DB blip during deploy, a managed-Postgres
// failover) it deliberately does not crash, and it used to simply skip the
// check and let the process serve. So a deploy that raced a failover could run
// for weeks with the check never performed. "It re-runs on the next boot"
// assumes a restart that may never come.
//
// Now /readyz gates on it. This is only meaningful because the platform health
// check probes /readyz (.do/app.yaml): an unverified instance never receives
// traffic and the previous version keeps serving. A blip delays readiness
// rather than silently disabling the control.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3001');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

// The gate only engages in production. Mock the config module rather than
// stubbing NODE_ENV=production on the process — the real schema then demands
// the full production secret set (KMS, metrics token, webhook secret, refresh
// pepper …) and `process.exit(1)`s during import, which tells us nothing about
// the behaviour under test.
vi.mock('../src/config/env.js', () => ({
  env: { NODE_ENV: 'production', LOG_LEVEL: 'silent' },
}));

// logger.ts builds a real pino instance from env at import time; the mocked env
// above has no full config and this test asserts nothing about logging.
vi.mock('../src/config/logger.js', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(),
  },
}));

/** Whether the boot-time assertion has proven the role safe. */
let verified = false;
/** Set by the test to decide what a re-probe does. */
let reprobeOutcome: 'verify' | 'stay-unverified' = 'stay-unverified';

vi.mock('../src/config/db.js', () => ({
  prisma: { $queryRaw: vi.fn(async () => [{ '?column?': 1 }]) },
  prismaAdmin: {},
  isRlsRoleVerified: () => verified,
  assertRuntimeRoleRespectsRls: vi.fn(async () => {
    if (reprobeOutcome === 'verify') verified = true;
  }),
  disconnectDb: async () => undefined,
}));

vi.mock('../src/shared/redisClient.js', () => ({ getRedisClient: async () => null }));

const { healthRouter } = await import('../src/modules/health/health.routes.js');

function app() {
  const a = express();
  a.use('/api/v1/health', healthRouter);
  return a;
}

beforeEach(() => {
  verified = false;
  reprobeOutcome = 'stay-unverified';
  vi.clearAllMocks();
});

describe('/readyz — RLS role gate in production', () => {
  it('refuses ready when the runtime role has never been verified', async () => {
    const res = await request(app()).get('/api/v1/health/readyz');
    expect(res.status).toBe(503);
    expect(res.body.rls_role).toBe('unverified');
  });

  it('still reports the database as reachable while refusing ready', async () => {
    // The distinction matters on-call: "DB down" and "DB fine but isolation
    // unproven" are different incidents with different responses.
    const res = await request(app()).get('/api/v1/health/readyz');
    expect(res.body.db).toBe('ok');
  });

  it('reports ready once a re-probe proves the role is RLS-enforced', async () => {
    reprobeOutcome = 'verify';
    const res = await request(app()).get('/api/v1/health/readyz');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
  });

  it('does not re-probe once already verified', async () => {
    verified = true;
    const db = await import('../src/config/db.js');
    const res = await request(app()).get('/api/v1/health/readyz');
    expect(res.status).toBe(200);
    expect(db.assertRuntimeRoleRespectsRls).not.toHaveBeenCalled();
  });

  it('never leaks the driver error detail on a failure response', async () => {
    // The route is public and is now the platform probe; Prisma connection
    // errors embed host, port and role.
    const res = await request(app()).get('/api/v1/health/readyz');
    expect(res.body.detail).toBeUndefined();
  });
});
