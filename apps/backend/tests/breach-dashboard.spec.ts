// SVT-WAVE36-BREACH-DASH-2026-05 — admin-only breach dashboard summary.

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
const USER_ADMIN = '22222222-2222-7222-8222-222222222222';
const USER_COUNSELLOR = '33333333-3333-7333-8333-333333333333';

type Breach = { id: string; tenant_id: string; due_by: Date; closed_at: Date | null };

const store = { breaches: [] as Breach[] };

vi.mock('../src/config/db.js', () => {
  const prisma = {
    breachIncident: {
      count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const tenantId = where['tenant_id'];
        const closed_at = where['closed_at'];
        const dueBy = where['due_by'] as { lt?: Date; gte?: Date; lte?: Date } | undefined;
        return store.breaches.filter((b) => {
          if (b.tenant_id !== tenantId) return false;
          if (closed_at === null && b.closed_at !== null) return false;
          if (dueBy?.lt && !(b.due_by < dueBy.lt)) return false;
          if (dueBy?.gte && !(b.due_by >= dueBy.gte)) return false;
          if (dueBy?.lte && !(b.due_by <= dueBy.lte)) return false;
          return true;
        }).length;
      }),
    },
    accessTokenDenylist: { findUnique: vi.fn(async () => null) },
    $extends: vi.fn(function (this: unknown) { return prisma; }),
    $transaction: vi.fn(async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma)),
    $executeRaw: vi.fn(async () => 1),
  };
  return { prisma, disconnectDb: async () => undefined };
});

const { authenticate, requireRole } = await import('../src/middlewares/auth.js');
const { tenantContext } = await import('../src/middlewares/tenantContext.js');
const { errorHandler, notFoundHandler } = await import('../src/middlewares/errorHandler.js');
const { breachController } = await import('../src/modules/breach/controller.js');
const { signAccessToken } = await import('../src/shared/jwt.js');

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  // Wire only the dashboard-summary route (matches the prod routes.ts middleware order).
  app.get(
    '/api/v1/breach-incidents/dashboard-summary',
    authenticate,
    tenantContext,
    requireRole('ADMIN'),
    breachController.dashboardSummary,
  );
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

let app: Express;
const tokens: Record<string, string> = {};

beforeEach(async () => {
  store.breaches.length = 0;
  if (!app) app = makeApp();
  if (!tokens['admin']) {
    tokens['admin'] = await signAccessToken({ sub: USER_ADMIN, tid: TENANT, role: 'ADMIN', jti: randomUUID() });
    tokens['counsellor'] = await signAccessToken({ sub: USER_COUNSELLOR, tid: TENANT, role: 'COUNSELLOR', jti: randomUUID() });
  }
});

const HOUR_MS = 3600_000;

function seedBreach(opts: Partial<Breach> = {}): Breach {
  const b: Breach = {
    id: randomUUID(), tenant_id: TENANT,
    due_by: new Date(Date.now() + 12 * HOUR_MS),
    closed_at: null,
    ...opts,
  };
  store.breaches.push(b);
  return b;
}

describe('GET /api/v1/breach-incidents/dashboard-summary', () => {
  it('returns 401 without bearer', async () => {
    const res = await request(app).get('/api/v1/breach-incidents/dashboard-summary');
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin', async () => {
    const res = await request(app)
      .get('/api/v1/breach-incidents/dashboard-summary')
      .set('Authorization', `Bearer ${tokens['counsellor']}`);
    expect(res.status).toBe(403);
  });

  it('returns zeroed counts when no breaches', async () => {
    const res = await request(app)
      .get('/api/v1/breach-incidents/dashboard-summary')
      .set('Authorization', `Bearer ${tokens['admin']}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ open: 0, overdue: 0, due_within_24h: 0 });
  });

  it('counts open vs overdue vs due-within-24h correctly', async () => {
    // overdue: due 2h ago, still open
    seedBreach({ due_by: new Date(Date.now() - 2 * HOUR_MS) });
    // due soon: due in 12h
    seedBreach({ due_by: new Date(Date.now() + 12 * HOUR_MS) });
    // due later: due in 48h (open but not due-soon)
    seedBreach({ due_by: new Date(Date.now() + 48 * HOUR_MS) });
    // closed: should be excluded everywhere
    seedBreach({ due_by: new Date(Date.now() + 12 * HOUR_MS), closed_at: new Date() });

    const res = await request(app)
      .get('/api/v1/breach-incidents/dashboard-summary')
      .set('Authorization', `Bearer ${tokens['admin']}`);
    expect(res.status).toBe(200);
    expect(res.body.data.open).toBe(3);
    expect(res.body.data.overdue).toBe(1);
    expect(res.body.data.due_within_24h).toBe(1);
  });

  it('overdue and due-within-24h are disjoint buckets', async () => {
    // The "due ≤ 24h" set is gte: now AND lte: now+24h, so overdue rows must
    // never be double-counted here.
    seedBreach({ due_by: new Date(Date.now() - 1 * HOUR_MS) }); // overdue
    seedBreach({ due_by: new Date(Date.now() + 1 * HOUR_MS) }); // due-soon
    const res = await request(app)
      .get('/api/v1/breach-incidents/dashboard-summary')
      .set('Authorization', `Bearer ${tokens['admin']}`);
    expect(res.body.data.overdue).toBe(1);
    expect(res.body.data.due_within_24h).toBe(1);
    expect(res.body.data.open).toBe(2);
  });
});
