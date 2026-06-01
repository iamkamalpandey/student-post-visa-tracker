// SVT-WAVE10/11-OUTBOX-2026-05 — admin outbox endpoints (health/list/requeue/bulk).
//
// Mocks prisma + audit so we exercise the actual controller branches end-to-end
// over Express. No real DB required.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
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

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const ADMIN_ID = '22222222-2222-7222-8222-222222222222';

type MsgRow = {
  id: string;
  tenant_id: string;
  thread_id: string;
  status: string;
  attempts: number;
  next_retry_at: Date | null;
  sent_at: Date | null;
  subject: string | null;
  body: string;
  metadata: Record<string, unknown> | null;
  recipient_user_id: string | null;
  provider_id: string | null;
  created_at: Date;
  last_attempt_at: Date | null;
};

const store = { messages: [] as MsgRow[] };

function seed() {
  store.messages.length = 0;
  // 1 queued, 2 retrying, 3 terminal, 1 sent.
  const now = new Date();
  const past = new Date(now.getTime() - 60_000);
  store.messages.push(
    mk('queued', 'QUEUED', 0, null),
    mk('retry1', 'FAILED', 1, past),
    mk('retry2', 'FAILED', 2, past),
    mk('aaaaaaaa-1111-7aaa-8aaa-aaaaaaaaaaaa', 'FAILED', 3, null),
    mk('term2', 'FAILED', 3, null),
    mk('term3', 'FAILED', 1, null),  // attempts<3 but next_retry_at null → terminal
    mk('sent1', 'SENT', 1, null, new Date(now.getTime() - 60 * 60_000)),
  );
}
function mk(id: string, status: string, attempts: number, next_retry_at: Date | null, sent_at: Date | null = null): MsgRow {
  return {
    id, tenant_id: TENANT_A, thread_id: 't', status, attempts, next_retry_at,
    sent_at, subject: null, body: 'body', metadata: null, recipient_user_id: null,
    provider_id: null, created_at: new Date(), last_attempt_at: null,
  };
}

vi.mock('../src/config/db.js', () => {
  const messages = {
    count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => filter(where).length),
    findMany: vi.fn(async ({ where, take, cursor, skip }: {
      where: Record<string, unknown>; take?: number; cursor?: { id: string }; skip?: number;
    }) => {
      let rows = filter(where);
      if (cursor) {
        const idx = rows.findIndex((r) => r.id === cursor.id);
        if (idx >= 0) rows = rows.slice(idx + (skip ?? 0));
      }
      if (typeof take === 'number') rows = rows.slice(0, take);
      return rows;
    }),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => filter(where)[0] ?? null),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const rows = filter(where);
      for (const r of rows) {
        for (const [k, v] of Object.entries(data)) {
          (r as Record<string, unknown>)[k] = v as never;
        }
      }
      return { count: rows.length };
    }),
  };
  const prisma = {
    commsMessage: messages,
    accessTokenDenylist: {
      // Returning null = "not denylisted" so authenticate middleware proceeds.
      findUnique: vi.fn(async () => null),
    },
    // tenantContext middleware calls prisma.$extends(...) — the noop returns
    // the same client so the controller picks the request-scoped path.
    $extends: vi.fn(function (this: unknown) { return prisma; }),
    $transaction: vi.fn(async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma)),
    $executeRaw: vi.fn(async () => 1),
  };
  return { prisma, disconnectDb: async () => undefined };
});

function filter(where: Record<string, unknown>): MsgRow[] {
  return store.messages.filter((r) => {
    if (where['tenant_id'] !== undefined && r.tenant_id !== where['tenant_id']) return false;
    if (where['id'] !== undefined && r.id !== where['id']) return false;
    if (where['status'] !== undefined) {
      const s = where['status'];
      if (typeof s === 'string' && r.status !== s) return false;
    }
    if (where['attempts'] && typeof where['attempts'] === 'object') {
      const a = where['attempts'] as { lt?: number; gte?: number };
      if (a.lt !== undefined && r.attempts >= a.lt) return false;
      if (a.gte !== undefined && r.attempts < a.gte) return false;
    }
    if (where['next_retry_at'] !== undefined) {
      const n = where['next_retry_at'];
      if (n === null && r.next_retry_at !== null) return false;
      if (typeof n === 'object' && n && (n as { not?: unknown }).not !== undefined && r.next_retry_at === null) return false;
      if (typeof n === 'object' && n && (n as { lte?: Date }).lte !== undefined && (!r.next_retry_at || r.next_retry_at > ((n as { lte: Date }).lte))) return false;
    }
    if (where['OR'] && Array.isArray(where['OR'])) {
      const passes = (where['OR'] as Array<Record<string, unknown>>).some((sub) => filter({ ...sub, id: r.id }).length > 0);
      if (!passes) return false;
    }
    if (where['sent_at'] && typeof where['sent_at'] === 'object') {
      const ge = (where['sent_at'] as { gte?: Date }).gte;
      if (ge && (!r.sent_at || r.sent_at < ge)) return false;
    }
    return true;
  });
}

vi.mock('../src/shared/audit.js', () => ({ writeAudit: vi.fn(async () => undefined) }));

const { authenticate } = await import('../src/middlewares/auth.js');
const { tenantContext } = await import('../src/middlewares/tenantContext.js');
const { errorHandler, notFoundHandler } = await import('../src/middlewares/errorHandler.js');
const { outboxAdminRouter } = await import('../src/modules/comms/routes.js');
const { signAccessToken } = await import('../src/shared/jwt.js');

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/v1/admin/comms/outbox', authenticate, tenantContext, outboxAdminRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

let app: Express;
let adminToken: string;

beforeAll(async () => {
  app = makeApp();
  adminToken = await signAccessToken({ sub: ADMIN_ID, tid: TENANT_A, role: 'ADMIN', jti: randomUUID() });
});

beforeEach(() => { seed(); });

describe('GET /admin/comms/outbox/health', () => {
  it('returns aggregated counts per status bucket', async () => {
    const res = await request(app)
      .get('/api/v1/admin/comms/outbox/health')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.queued).toBe(1);
    expect(res.body.data.retrying).toBe(2);
    expect(res.body.data.terminal_failed).toBe(3);
    expect(res.body.data.sent_last_24h).toBe(1);
  });
});

describe('GET /admin/comms/outbox/messages', () => {
  it('filters by QUEUED', async () => {
    const res = await request(app)
      .get('/api/v1/admin/comms/outbox/messages?status=QUEUED')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe('queued');
  });

  it('filters by virtual TERMINAL bucket', async () => {
    const res = await request(app)
      .get('/api/v1/admin/comms/outbox/messages?status=TERMINAL')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.data.map((m: { id: string }) => m.id);
    expect(ids).toContain('aaaaaaaa-1111-7aaa-8aaa-aaaaaaaaaaaa');
    expect(ids).toContain('term2');
    expect(ids).toContain('term3');
  });
});

describe('POST /admin/comms/outbox/:id/requeue', () => {
  it('flips a FAILED row to QUEUED + resets attempts', async () => {
    const res = await request(app)
      .post('/api/v1/admin/comms/outbox/aaaaaaaa-1111-7aaa-8aaa-aaaaaaaaaaaa/requeue')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(202);
    const row = store.messages.find((m) => m.id === 'aaaaaaaa-1111-7aaa-8aaa-aaaaaaaaaaaa')!;
    expect(row.status).toBe('QUEUED');
    expect(row.attempts).toBe(0);
    expect(row.next_retry_at).toBeNull();
  });
});

describe('POST /admin/comms/outbox/requeue-all', () => {
  it('requeues all terminal rows by default', async () => {
    const res = await request(app)
      .post('/api/v1/admin/comms/outbox/requeue-all')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.requeued).toBe(3); // aaaaaaaa-1111-7aaa-8aaa-aaaaaaaaaaaa, term2, term3
    expect(res.body.scope).toBe('terminal');
  });

  it('requeues retrying rows when scope=retrying', async () => {
    const res = await request(app)
      .post('/api/v1/admin/comms/outbox/requeue-all?scope=retrying')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.requeued).toBe(2);
  });

  it('rejects unknown scope with 400', async () => {
    const res = await request(app)
      .post('/api/v1/admin/comms/outbox/requeue-all?scope=bogus')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });
});
