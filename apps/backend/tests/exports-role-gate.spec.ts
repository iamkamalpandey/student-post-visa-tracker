// SVT-SEC-AUDIT-2026-05 — defence-in-depth role gate on the export job
// surface (GET /:job_id, GET /:job_id/download, POST /:job_id/cancel).
//
// The service-layer ownership check is the authoritative guard, but the route
// also requires the caller to be at least COUNSELLOR. VIEWER must be rejected
// before any controller code runs (so a misconfigured tenant cannot leak job
// metadata via the GET).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import express, { type Express } from 'express';
import request from 'supertest';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }) as string;

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3000');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('JWT_PRIVATE_KEY', PRIVATE_PEM);
vi.stubEnv('JWT_PUBLIC_KEY', PUBLIC_PEM);
vi.stubEnv('JWT_KID', 'test-kid');
vi.stubEnv('JWT_ISSUER', 'spv-api-test');
vi.stubEnv('JWT_AUDIENCE', 'spv-app-test');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

const TENANT = '11111111-1111-7111-8111-111111111111';
const USER_ID = '22222222-2222-7222-8222-222222222222';
const JOB_ID = '33333333-3333-7333-8333-333333333333';

// Minimal prisma — getJob does a findFirst against exportJob; cancelJob then
// hits updateMany. Returns a fixture row owned by the test user.
vi.mock('../src/config/db.js', () => {
  const job = {
    id: JOB_ID,
    tenant_id: TENANT,
    resource: 'students',
    format: 'csv',
    status: 'QUEUED' as string,
    created_by_id: USER_ID,
    row_total: 0,
    sha256: null as string | null,
  };
  const prisma: Record<string, unknown> = {
    exportJob: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        where['id'] === JOB_ID && where['tenant_id'] === TENANT ? job : null),
      findFirstOrThrow: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (where['id'] === JOB_ID && where['tenant_id'] === TENANT) return job;
        throw new Error('not found');
      }),
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(job, data);
        return job;
      }),
    },
    accessTokenDenylist: { findUnique: vi.fn(async () => null) },
    refreshToken: { updateMany: vi.fn(async () => ({ count: 0 })) },
  };
  prisma['$extends'] = vi.fn(function (this: unknown) { return prisma; });
  return { prisma, disconnectDb: async () => undefined };
});

vi.mock('../src/shared/audit.js', () => ({
  writeAudit: vi.fn(async () => undefined),
}));

const { authenticate } = await import('../src/middlewares/auth.js');
const { tenantContext } = await import('../src/middlewares/tenantContext.js');
const { exportsRouter } = await import('../src/modules/exports/exports.routes.js');
const { errorHandler, notFoundHandler } = await import('../src/middlewares/errorHandler.js');
const { signAccessToken } = await import('../src/shared/jwt.js');

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/exports', authenticate, tenantContext, exportsRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

const app = makeApp();

async function tokenFor(role: 'ADMIN' | 'COUNSELLOR' | 'VIEWER') {
  return signAccessToken({ sub: USER_ID, tid: TENANT, role, jti: randomUUID() });
}

beforeEach(() => {
  // No per-test state to reset — fixtures are module-scoped.
});

describe('exports role-gate (SVT-SEC-AUDIT-2026-05)', () => {
  it('VIEWER receives 403 on GET /:job_id', async () => {
    const tok = await tokenFor('VIEWER');
    const res = await request(app)
      .get(`/api/v1/exports/${JOB_ID}`)
      .set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(403);
  });

  it('VIEWER receives 403 on GET /:job_id/download', async () => {
    const tok = await tokenFor('VIEWER');
    const res = await request(app)
      .get(`/api/v1/exports/${JOB_ID}/download?nonce=stub`)
      .set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(403);
  });

  it('VIEWER receives 403 on POST /:job_id/cancel', async () => {
    const tok = await tokenFor('VIEWER');
    const res = await request(app)
      .post(`/api/v1/exports/${JOB_ID}/cancel`)
      .set('Authorization', `Bearer ${tok}`);
    // The VIEWER write-block in `authenticate` already 403s mutations for
    // viewer roles, but the route-level requireRole would 403 even on GETs
    // so the test pins the protected status either way.
    expect(res.status).toBe(403);
  });

  it('COUNSELLOR (owner) passes the gate on GET /:job_id', async () => {
    const tok = await tokenFor('COUNSELLOR');
    const res = await request(app)
      .get(`/api/v1/exports/${JOB_ID}`)
      .set('Authorization', `Bearer ${tok}`);
    // Service returns the job (QUEUED → no download_url). The gate is what we
    // are pinning; any 2xx confirms the role check passed.
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(JOB_ID);
  });

  it('COUNSELLOR (owner) passes the gate on POST /:job_id/cancel', async () => {
    const tok = await tokenFor('COUNSELLOR');
    const res = await request(app)
      .post(`/api/v1/exports/${JOB_ID}/cancel`)
      .set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(200);
  });
});
