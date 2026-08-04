// SVT-WAVE-BILLING-2026-05 — Real PDF invoice endpoint.
//
// Exercises GET /api/v1/billing/plans/:id/invoice.pdf end-to-end via supertest:
//   - 200 + application/pdf + %PDF-1.x magic bytes on the happy path
//   - ETag round-trip → 304 Not Modified when If-None-Match matches
//   - 404 when the plan UUID isn't in the tenant store
//   - 403 when the caller's role isn't ADMIN/COUNSELLOR (VIEWER GETs are
//     allowed to authenticate but blocked by requireRole on this route)
//
// Builds an Express app from the real billingRouter so middleware (auth +
// tenantContext + billingEnabled) is in the critical path; Prisma is mocked
// in-memory so the test runs without a live database.

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
const USER = '22222222-2222-7222-8222-222222222222';
const ENROLLMENT = '33333333-3333-7333-8333-333333333333';
const PLAN_ID = '44444444-4444-7444-8444-444444444444';
const MISSING_ID = '55555555-5555-7555-8555-555555555555';

type Plan = {
  id: string;
  tenant_id: string;
  enrollment_id: string;
  cadence: string;
  status: string;
  currency: string;
  total_minor: bigint;
  scholarship_minor: bigint;
  starts_on: Date;
  notes: string | null;
  version: number;
  deleted_at: Date | null;
};
type Installment = {
  id: string;
  fee_plan_id: string;
  sequence_no: number;
  label: string;
  due_on: Date;
  gross_minor: bigint;
  paid_minor: bigint;
  balance_minor: bigint;
  status: string;
  deleted_at: Date | null;
};

const store: {
  plans: Plan[];
  installments: Installment[];
  tenant: { id: string; billing_enabled: boolean };
} = {
  plans: [
    {
      id: PLAN_ID,
      tenant_id: TENANT,
      enrollment_id: ENROLLMENT,
      cadence: 'MONTHLY',
      status: 'ACTIVE',
      currency: 'USD',
      total_minor: 12000n,
      scholarship_minor: 0n,
      starts_on: new Date('2026-09-01'),
      notes: null,
      version: 1,
      deleted_at: null,
    },
  ],
  installments: [
    { id: randomUUID(), fee_plan_id: PLAN_ID, sequence_no: 1, label: 'Month 1', due_on: new Date('2026-09-01'), gross_minor: 4000n, paid_minor: 0n, balance_minor: 4000n, status: 'SCHEDULED', deleted_at: null },
    { id: randomUUID(), fee_plan_id: PLAN_ID, sequence_no: 2, label: 'Month 2', due_on: new Date('2026-10-01'), gross_minor: 4000n, paid_minor: 4000n, balance_minor: 0n, status: 'PAID',     deleted_at: null },
    { id: randomUUID(), fee_plan_id: PLAN_ID, sequence_no: 3, label: 'Month 3', due_on: new Date('2026-11-01'), gross_minor: 4000n, paid_minor: 0n, balance_minor: 4000n, status: 'SCHEDULED', deleted_at: null },
  ],
  tenant: { id: TENANT, billing_enabled: true },
};

vi.mock('../src/config/db.js', () => {
  const prisma = {
    tenant: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === store.tenant.id ? store.tenant : null,
      ),
    },
    feePlan: {
      findFirst: vi.fn(async ({ where, include }: { where: Record<string, unknown>; include?: { installments?: unknown } }) => {
        const p = store.plans.find(
          (x) =>
            x.id === where['id'] &&
            x.tenant_id === where['tenant_id'] &&
            (where['deleted_at'] === null ? x.deleted_at == null : true),
        );
        if (!p) return null;
        if (include?.installments) {
          return {
            ...p,
            installments: store.installments
              .filter((i) => i.fee_plan_id === p.id && i.deleted_at == null)
              .sort((a, b) => a.sequence_no - b.sequence_no),
          };
        }
        return p;
      }),
    },
    accessTokenDenylist: { findUnique: vi.fn(async () => null) },
    refreshToken: { updateMany: vi.fn(async () => ({ count: 0 })) },
    $extends: vi.fn(function (this: unknown) { return prisma; }),
    $transaction: vi.fn(async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma)),
    $executeRaw: vi.fn(async () => 1),
  };
  return { prisma, prismaAdmin: { user: { findUnique: async () => ({ sessions_valid_from: null }) } }, disconnectDb: async () => undefined };
});

const { authenticate } = await import('../src/middlewares/auth.js');
const { tenantContext } = await import('../src/middlewares/tenantContext.js');
const { errorHandler, notFoundHandler } = await import('../src/middlewares/errorHandler.js');
const { billingRouter } = await import('../src/modules/billing/billing.routes.js');
const { _clearBillingEnabledCache } = await import('../src/modules/billing/middleware.js');
const { signAccessToken } = await import('../src/shared/jwt.js');

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  // billingRouter already mounts authenticate + tenantContext + billingEnabled,
  // but the production mount path matches what we use here.
  app.use('/api/v1/billing', billingRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

let app: Express;
let adminToken: string;
let viewerToken: string;

beforeEach(async () => {
  _clearBillingEnabledCache();
  if (!app) app = makeApp();
  adminToken = await signAccessToken({ sub: USER, tid: TENANT, role: 'ADMIN', jti: randomUUID() });
  viewerToken = await signAccessToken({ sub: USER, tid: TENANT, role: 'VIEWER', jti: randomUUID() });
});

describe('GET /api/v1/billing/plans/:id/invoice.pdf', () => {
  it('returns 200 + application/pdf + %PDF magic bytes', async () => {
    const res = await request(app)
      .get(`/api/v1/billing/plans/${PLAN_ID}/invoice.pdf`)
      .set('Authorization', `Bearer ${adminToken}`)
      .buffer(true)
      .parse((response, cb) => {
        // Supertest default body parser will mangle a binary body; collect
        // raw bytes ourselves so we can assert on the magic header.
        const chunks: Buffer[] = [];
        response.on('data', (c: Buffer) => chunks.push(c));
        response.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['etag']).toMatch(/^"[a-f0-9]{32}"$/);
    expect(res.headers['cache-control']).toMatch(/private/);
    expect(res.headers['content-disposition']).toMatch(
      new RegExp(`inline; filename="invoice-${PLAN_ID}\\.pdf"`),
    );
    const body = res.body as Buffer;
    expect(body.length).toBeGreaterThan(200);
    // PDF magic header: %PDF-1.x
    expect(body.slice(0, 5).toString('ascii')).toBe('%PDF-');
    expect(body.slice(0, 8).toString('ascii')).toMatch(/^%PDF-1\./);
  });

  it('ETag round-trip → 304 on If-None-Match match', async () => {
    const first = await request(app)
      .get(`/api/v1/billing/plans/${PLAN_ID}/invoice.pdf`)
      .set('Authorization', `Bearer ${adminToken}`)
      .buffer(true)
      .parse((response, cb) => {
        const chunks: Buffer[] = [];
        response.on('data', (c: Buffer) => chunks.push(c));
        response.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(first.status).toBe(200);
    const etag = first.headers['etag'] as string;
    expect(etag).toBeTruthy();

    const second = await request(app)
      .get(`/api/v1/billing/plans/${PLAN_ID}/invoice.pdf`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('If-None-Match', etag);
    expect(second.status).toBe(304);
    // 304 must not carry a body
    expect(second.text === '' || second.text == null).toBe(true);
  });

  it('returns 404 when the plan does not exist in the tenant', async () => {
    const res = await request(app)
      .get(`/api/v1/billing/plans/${MISSING_ID}/invoice.pdf`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it('returns 403 when caller is VIEWER (not ADMIN/COUNSELLOR)', async () => {
    const res = await request(app)
      .get(`/api/v1/billing/plans/${PLAN_ID}/invoice.pdf`)
      .set('Authorization', `Bearer ${viewerToken}`);
    expect(res.status).toBe(403);
  });

  it('returns 401 without a bearer', async () => {
    const res = await request(app).get(`/api/v1/billing/plans/${PLAN_ID}/invoice.pdf`);
    expect(res.status).toBe(401);
  });
});
