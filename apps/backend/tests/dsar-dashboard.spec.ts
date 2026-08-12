// SVT-WAVE37-DSAR-DASH-2026-05 — admin-only DSAR dashboard summary.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
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
const ADMIN = '22222222-2222-7222-8222-222222222222';
const COUNSELLOR = '33333333-3333-7333-8333-333333333333';

type DSAR = {
  id: string; tenant_id: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'REJECTED' | 'EXPIRED';
  due_by: Date;
};

const store = { rows: [] as DSAR[] };

vi.mock('../src/config/db.js', () => {
  const prisma = {
    dSARRequest: {
      count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const tenantId = where['tenant_id'];
        const status = where['status'] as { notIn?: string[] } | undefined;
        const dueBy = where['due_by'] as { lt?: Date; gte?: Date; lte?: Date } | undefined;
        return store.rows.filter((r) => {
          if (r.tenant_id !== tenantId) return false;
          if (status?.notIn && status.notIn.includes(r.status)) return false;
          if (dueBy?.lt && !(r.due_by < dueBy.lt)) return false;
          if (dueBy?.gte && !(r.due_by >= dueBy.gte)) return false;
          if (dueBy?.lte && !(r.due_by <= dueBy.lte)) return false;
          return true;
        }).length;
      }),
    },
    accessTokenDenylist: { findUnique: vi.fn(async () => null) },
    $extends: vi.fn(function (this: unknown) { return prisma; }),
    $transaction: vi.fn(async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma)),
    $executeRaw: vi.fn(async () => 1),
  };
  return { prisma, prismaAdmin: {
    // SVT-SEC-2026-08 — authenticate() reads the JTI denylist via the
    // BYPASS-RLS client (it runs before tenantContext sets the GUC) and fails
    // CLOSED when the lookup throws. null = "this token was never revoked".
    accessTokenDenylist: { findUnique: async () => null }, user: { findUnique: async () => ({ sessions_valid_from: null }) } }, disconnectDb: async () => undefined };
});

const { authenticate } = await import('../src/middlewares/auth.js');
const { tenantContext } = await import('../src/middlewares/tenantContext.js');
const { errorHandler, notFoundHandler } = await import('../src/middlewares/errorHandler.js');
const { dsarRouter } = await import('../src/modules/dsar/routes.js');
const { signAccessToken } = await import('../src/shared/jwt.js');

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/dsar', authenticate, tenantContext, dsarRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

let app: Express;
const tokens: Record<string, string> = {};

beforeEach(async () => {
  store.rows.length = 0;
  if (!app) app = makeApp();
  if (!tokens['admin']) {
    tokens['admin'] = await signAccessToken({ sub: ADMIN, tid: TENANT, role: 'ADMIN', jti: randomUUID() });
    tokens['counsellor'] = await signAccessToken({ sub: COUNSELLOR, tid: TENANT, role: 'COUNSELLOR', jti: randomUUID() });
  }
});

const DAY_MS = 24 * 3600_000;

function seedDsar(opts: Partial<DSAR> = {}): DSAR {
  const r: DSAR = {
    id: randomUUID(), tenant_id: TENANT,
    status: 'PENDING',
    due_by: new Date(Date.now() + 15 * DAY_MS),
    ...opts,
  };
  store.rows.push(r);
  return r;
}

describe('GET /api/v1/dsar/dashboard-summary', () => {
  it('returns 401 without bearer', async () => {
    const res = await request(app).get('/api/v1/dsar/dashboard-summary');
    expect(res.status).toBe(401);
  });

  it('returns 403 for counsellor', async () => {
    const res = await request(app)
      .get('/api/v1/dsar/dashboard-summary')
      .set('Authorization', `Bearer ${tokens['counsellor']}`);
    expect(res.status).toBe(403);
  });

  it('returns zeroed counts when no DSAR rows', async () => {
    const res = await request(app)
      .get('/api/v1/dsar/dashboard-summary')
      .set('Authorization', `Bearer ${tokens['admin']}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ open: 0, overdue: 0, due_within_3d: 0 });
  });

  it('counts open vs overdue vs due-within-3d, excluding terminal statuses', async () => {
    // Overdue PENDING
    seedDsar({ status: 'PENDING', due_by: new Date(Date.now() - 1 * DAY_MS) });
    // Due-soon IN_PROGRESS
    seedDsar({ status: 'IN_PROGRESS', due_by: new Date(Date.now() + 2 * DAY_MS) });
    // Open but far off
    seedDsar({ status: 'PENDING', due_by: new Date(Date.now() + 20 * DAY_MS) });
    // Terminal statuses: excluded everywhere
    seedDsar({ status: 'COMPLETED', due_by: new Date(Date.now() - 1 * DAY_MS) });
    seedDsar({ status: 'REJECTED', due_by: new Date(Date.now() + 1 * DAY_MS) });
    seedDsar({ status: 'EXPIRED', due_by: new Date(Date.now() + 1 * DAY_MS) });

    const res = await request(app)
      .get('/api/v1/dsar/dashboard-summary')
      .set('Authorization', `Bearer ${tokens['admin']}`);
    expect(res.body.data.open).toBe(3);
    expect(res.body.data.overdue).toBe(1);
    expect(res.body.data.due_within_3d).toBe(1);
  });
});
