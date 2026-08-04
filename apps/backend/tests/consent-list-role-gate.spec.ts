// SVT-WAVE-PRIV-C4-2026-05 — GET /api/v1/consents role gate.
//   * ADMIN sees all subjects in their tenant.
//   * COUNSELLOR sees all subjects in their tenant.
//   * VIEWER auto-filters to (subject_type='user', subject_id=req.user.sub) —
//     cannot enumerate other subjects.
//   * Unknown role string is rejected at the route gate (403 before service).

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import express, { type Express } from 'express';
import request from 'supertest';
import { SignJWT, importPKCS8 } from 'jose';

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

type ConsentRow = {
  id: string;
  tenant_id: string;
  subject_type: string;
  subject_id: string;
  purpose: string;
  lawful_basis: string;
  granted: boolean;
  granted_at: Date;
  revoked_at: Date | null;
};

const store = { rows: [] as ConsentRow[] };

const TENANT = '11111111-1111-7111-8111-111111111111';
const ADMIN_ID = '22222222-2222-7222-8222-222222222222';
const COUNSELLOR_ID = '33333333-3333-7333-8333-333333333333';
const VIEWER_ID = '44444444-4444-7444-8444-444444444444';
const OTHER_USER = '55555555-5555-7555-8555-555555555555';

function matches(row: ConsentRow, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (v === undefined) continue;
    if (v === null) {
      if ((row as unknown as Record<string, unknown>)[k] != null) return false;
      continue;
    }
    if ((row as unknown as Record<string, unknown>)[k] !== v) return false;
  }
  return true;
}

vi.mock('../src/config/db.js', () => {
  const prisma: Record<string, unknown> = {
    consentRecord: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        store.rows.find((r) => matches(r, where)) ?? null,
      ),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        store.rows.filter((r) => matches(r, where)),
      ),
    },
    accessTokenDenylist: { findUnique: vi.fn(async () => null) },
    refreshToken: { updateMany: vi.fn(async () => ({ count: 0 })) },
    auditLog: { create: vi.fn(async () => ({})), findFirst: vi.fn(async () => null) },
    $transaction: vi.fn(async (fn: unknown) => (typeof fn === 'function' ? (fn as (tx: unknown) => unknown)(prisma) : fn)),
    $executeRaw: vi.fn(async () => 1),
    $extends: vi.fn(function (this: unknown) { return prisma; }),
  };
  return { prisma, prismaAdmin: { user: { findUnique: async () => ({ sessions_valid_from: null }) } }, disconnectDb: async () => undefined };
});

vi.mock('../src/shared/audit.js', () => ({ writeAudit: vi.fn(async () => undefined) }));

vi.mock('../src/shared/idempotencyHandler.js', () => ({
  runIdempotent: async (
    _req: unknown,
    res: { status: (n: number) => { json: (b: unknown) => unknown } },
    _opts: unknown,
    work: () => Promise<unknown>,
  ) => {
    const body = await work();
    res.status(201).json(body);
  },
}));

const { authenticate } = await import('../src/middlewares/auth.js');
const { tenantContext } = await import('../src/middlewares/tenantContext.js');
const { consentRouter } = await import('../src/modules/consent/routes.js');
const { errorHandler, notFoundHandler } = await import('../src/middlewares/errorHandler.js');
const { signAccessToken } = await import('../src/shared/jwt.js');

function app(): Express {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/consents', authenticate, tenantContext, consentRouter);
  a.use(notFoundHandler);
  a.use(errorHandler);
  return a;
}

let server: Express;
beforeAll(() => { server = app(); });

beforeEach(() => {
  store.rows.length = 0;
  store.rows.push(
    { id: randomUUID(), tenant_id: TENANT, subject_type: 'user', subject_id: VIEWER_ID, purpose: 'cookies_analytics', lawful_basis: 'CONSENT', granted: true, granted_at: new Date(), revoked_at: null },
    { id: randomUUID(), tenant_id: TENANT, subject_type: 'user', subject_id: OTHER_USER, purpose: 'marketing', lawful_basis: 'CONSENT', granted: true, granted_at: new Date(), revoked_at: null },
    { id: randomUUID(), tenant_id: TENANT, subject_type: 'student', subject_id: randomUUID(), purpose: 'data_processing', lawful_basis: 'CONTRACT', granted: true, granted_at: new Date(), revoked_at: null },
  );
});

async function tokenFor(role: 'ADMIN' | 'COUNSELLOR' | 'VIEWER'): Promise<string> {
  const sub = role === 'ADMIN' ? ADMIN_ID : role === 'COUNSELLOR' ? COUNSELLOR_ID : VIEWER_ID;
  return signAccessToken({ sub, tid: TENANT, role, jti: randomUUID() });
}

async function tokenWithCustomRole(role: string): Promise<string> {
  const key = await importPKCS8(PRIVATE_PEM, 'RS256');
  return new SignJWT({ sub: VIEWER_ID, tid: TENANT, role })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
    .setIssuedAt()
    .setIssuer('spv-api-test')
    .setAudience('spv-app-test')
    .setJti(randomUUID())
    .setExpirationTime('15m')
    .sign(key);
}

describe('GET /api/v1/consents role gate', () => {
  it('ADMIN sees every row in the tenant', async () => {
    const tok = await tokenFor('ADMIN');
    const res = await request(server).get('/api/v1/consents').set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
  });

  it('COUNSELLOR sees every row in the tenant', async () => {
    const tok = await tokenFor('COUNSELLOR');
    const res = await request(server).get('/api/v1/consents').set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
  });

  it('VIEWER only sees their own user consent rows', async () => {
    const tok = await tokenFor('VIEWER');
    const res = await request(server).get('/api/v1/consents').set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].subject_id).toBe(VIEWER_ID);
    expect(res.body.data[0].subject_type).toBe('user');
  });

  it('VIEWER cannot enumerate another subject by passing subject_id', async () => {
    const tok = await tokenFor('VIEWER');
    const res = await request(server)
      .get('/api/v1/consents')
      .query({ subject_id: OTHER_USER })
      .set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(200);
    // Even though the caller asked for OTHER_USER, the response is silently
    // re-scoped to self — never confirms or denies the target's existence.
    const rows = res.body.data as Array<{ subject_id: string }>;
    for (const r of rows) expect(r.subject_id).toBe(VIEWER_ID);
  });

  it('unknown role string is 403 at the route gate', async () => {
    const tok = await tokenWithCustomRole('GUEST');
    const res = await request(server).get('/api/v1/consents').set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(403);
  });
});
