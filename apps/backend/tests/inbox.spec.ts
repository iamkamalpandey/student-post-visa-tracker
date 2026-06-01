// SVT-WAVE32-INBOX-2026-05 — per-user inbox surface tests.
// Covers: list/unread-count, mark-read (single + bulk), tenant scoping, RBAC
// (every authenticated role gets an inbox), and cross-user isolation.

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

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TENANT_B = '99999999-9999-7999-8999-999999999999';
const USER_A = '22222222-2222-7222-8222-222222222222';
const USER_B = '33333333-3333-7333-8333-333333333333';

type MsgRow = {
  id: string;
  tenant_id: string;
  recipient_user_id: string | null;
  direction: 'INBOUND' | 'OUTBOUND';
  body: string;
  status: string;
  sent_at: Date | null;
  read_at: Date | null;
  metadata: Record<string, unknown> | null;
};

const store = { messages: [] as MsgRow[], audits: [] as Array<Record<string, unknown>> };

vi.mock('../src/config/db.js', () => {
  const prisma = {
    commsMessage: {
      findMany: vi.fn(async ({ where, take, orderBy }: { where: Record<string, unknown>; take?: number; orderBy?: unknown }) => {
        let rows = store.messages.filter((m) => m.tenant_id === where['tenant_id']);
        if (where['recipient_user_id']) {
          rows = rows.filter((m) => m.recipient_user_id === where['recipient_user_id']);
        }
        if (where['direction']) rows = rows.filter((m) => m.direction === where['direction']);
        if (where['read_at'] === null) rows = rows.filter((m) => m.read_at == null);
        // Match the controller ordering when supplied.
        if (orderBy && typeof orderBy === 'object' && 'sent_at' in (orderBy as object)) {
          rows = rows.sort(
            (a, b) => (b.sent_at?.getTime() ?? 0) - (a.sent_at?.getTime() ?? 0),
          );
        }
        return take ? rows.slice(0, take) : rows;
      }),
      count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        let rows = store.messages.filter((m) => m.tenant_id === where['tenant_id']);
        if (where['recipient_user_id']) rows = rows.filter((m) => m.recipient_user_id === where['recipient_user_id']);
        if (where['direction']) rows = rows.filter((m) => m.direction === where['direction']);
        if (where['read_at'] === null) rows = rows.filter((m) => m.read_at == null);
        return rows.length;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        let count = 0;
        for (const m of store.messages) {
          if (m.tenant_id !== where['tenant_id']) continue;
          if (where['id'] && m.id !== where['id']) continue;
          if (where['recipient_user_id'] && m.recipient_user_id !== where['recipient_user_id']) continue;
          if (where['read_at'] === null && m.read_at != null) continue;
          for (const [k, v] of Object.entries(data)) (m as Record<string, unknown>)[k] = v as never;
          count += 1;
        }
        return { count };
      }),
      findUnique: vi.fn(async () => null),
    },
    accessTokenDenylist: { findUnique: vi.fn(async () => null) },
    auditLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        store.audits.push(data);
        return data;
      }),
      findFirst: vi.fn(async () => null),
    },
    $extends: vi.fn(function (this: unknown) { return prisma; }),
    $transaction: vi.fn(async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma)),
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async () => [{ entry_hash: null }]),
  };
  return { prisma, disconnectDb: async () => undefined };
});

const { authenticate } = await import('../src/middlewares/auth.js');
const { tenantContext } = await import('../src/middlewares/tenantContext.js');
const { errorHandler, notFoundHandler } = await import('../src/middlewares/errorHandler.js');
const { inboxRouter } = await import('../src/modules/comms/routes.js');
const { signAccessToken } = await import('../src/shared/jwt.js');

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/inbox', authenticate, tenantContext, inboxRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

let app: Express;
const tokens: Record<string, string> = {};

beforeEach(async () => {
  store.messages.length = 0;
  store.audits.length = 0;
  if (!app) app = makeApp();
  if (!tokens['userA-admin']) {
    tokens['userA-admin'] = await signAccessToken({ sub: USER_A, tid: TENANT_A, role: 'ADMIN', jti: randomUUID() });
    tokens['userB-counsellor'] = await signAccessToken({ sub: USER_B, tid: TENANT_A, role: 'COUNSELLOR', jti: randomUUID() });
    tokens['userA-viewer-tenantB'] = await signAccessToken({ sub: USER_A, tid: TENANT_B, role: 'VIEWER', jti: randomUUID() });
  }
});

function seedMsg(opts: Partial<MsgRow> = {}): MsgRow {
  const m: MsgRow = {
    id: randomUUID(),
    tenant_id: TENANT_A,
    recipient_user_id: USER_A,
    direction: 'OUTBOUND',
    body: 'hello',
    status: 'SENT',
    sent_at: new Date(),
    read_at: null,
    metadata: null,
    ...opts,
  };
  store.messages.push(m);
  return m;
}

describe('GET /api/v1/inbox/messages', () => {
  it('returns 401 without bearer', async () => {
    const res = await request(app).get('/api/v1/inbox/messages');
    expect(res.status).toBe(401);
  });

  it('returns recipient-addressed OUTBOUND messages with unread_count', async () => {
    seedMsg({ recipient_user_id: USER_A, read_at: null, body: 'unread-1' });
    seedMsg({ recipient_user_id: USER_A, read_at: new Date(), body: 'read-1' });
    seedMsg({ recipient_user_id: USER_B, read_at: null, body: 'someone-else' });
    const res = await request(app)
      .get('/api/v1/inbox/messages')
      .set('Authorization', `Bearer ${tokens['userA-admin']}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.unread_count).toBe(1);
  });

  it('?unread=true narrows to unread only', async () => {
    seedMsg({ recipient_user_id: USER_A, read_at: null });
    seedMsg({ recipient_user_id: USER_A, read_at: new Date() });
    const res = await request(app)
      .get('/api/v1/inbox/messages?unread=true')
      .set('Authorization', `Bearer ${tokens['userA-admin']}`);
    expect(res.body.data).toHaveLength(1);
  });

  it('cross-tenant access cannot read other tenant messages', async () => {
    seedMsg({ tenant_id: TENANT_A, recipient_user_id: USER_A });
    const res = await request(app)
      .get('/api/v1/inbox/messages')
      .set('Authorization', `Bearer ${tokens['userA-viewer-tenantB']}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.unread_count).toBe(0);
  });

  it('inbox accessible without admin role (every user has an inbox)', async () => {
    seedMsg({ recipient_user_id: USER_B });
    const res = await request(app)
      .get('/api/v1/inbox/messages')
      .set('Authorization', `Bearer ${tokens['userB-counsellor']}`);
    expect(res.status).toBe(200);
  });
});

describe('POST /api/v1/inbox/messages/:id/read', () => {
  it('marks one message read; cannot touch another user', async () => {
    const mine = seedMsg({ recipient_user_id: USER_A, read_at: null });
    const theirs = seedMsg({ recipient_user_id: USER_B, read_at: null });
    const res = await request(app)
      .post(`/api/v1/inbox/messages/${mine.id}/read`)
      .set('Authorization', `Bearer ${tokens['userA-admin']}`);
    expect(res.status).toBe(204);
    expect(store.messages.find((m) => m.id === mine.id)?.read_at).not.toBeNull();
    expect(store.messages.find((m) => m.id === theirs.id)?.read_at).toBeNull();
  });
});

// SVT-WAVE32-MARK-ALL-READ-2026-05
describe('POST /api/v1/inbox/messages/read-all', () => {
  it('returns 401 without bearer', async () => {
    const res = await request(app).post('/api/v1/inbox/messages/read-all').send({});
    expect(res.status).toBe(401);
  });

  it('marks every unread recipient row read; returns count', async () => {
    seedMsg({ recipient_user_id: USER_A, read_at: null });
    seedMsg({ recipient_user_id: USER_A, read_at: null });
    seedMsg({ recipient_user_id: USER_A, read_at: new Date() }); // already read
    seedMsg({ recipient_user_id: USER_B, read_at: null }); // different user
    const res = await request(app)
      .post('/api/v1/inbox/messages/read-all')
      .set('Authorization', `Bearer ${tokens['userA-admin']}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2);
    // Other user's row untouched.
    const others = store.messages.filter((m) => m.recipient_user_id === USER_B && m.read_at == null);
    expect(others).toHaveLength(1);
    // Audit emitted exactly once (we asked for bulk).
    const bulkAudits = store.audits.filter((a) => a['action'] === 'comms.message.read_bulk');
    expect(bulkAudits).toHaveLength(1);
  });

  it('returns updated=0 when nothing to clear', async () => {
    seedMsg({ recipient_user_id: USER_A, read_at: new Date() });
    const res = await request(app)
      .post('/api/v1/inbox/messages/read-all')
      .set('Authorization', `Bearer ${tokens['userA-admin']}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(0);
    // No audit row when nothing changed (avoid noise).
    expect(store.audits.filter((a) => a['action'] === 'comms.message.read_bulk')).toHaveLength(0);
  });

  it('cross-tenant request only clears caller tenant rows', async () => {
    seedMsg({ tenant_id: TENANT_A, recipient_user_id: USER_A, read_at: null });
    seedMsg({ tenant_id: TENANT_B, recipient_user_id: USER_A, read_at: null });
    const res = await request(app)
      .post('/api/v1/inbox/messages/read-all')
      .set('Authorization', `Bearer ${tokens['userA-admin']}`) // tenant A
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1);
    const tenantBRow = store.messages.find((m) => m.tenant_id === TENANT_B);
    expect(tenantBRow?.read_at).toBeNull();
  });
});
