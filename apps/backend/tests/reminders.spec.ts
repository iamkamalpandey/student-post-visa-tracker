// Reminders module integration tests.
//
// Pattern: mock @prisma/client + the request-scoped DB fallback so we can drive
// the in-memory store the routers see. We mount the *real* remindersRouter
// behind authenticate + tenantContext (matching app.ts) and exercise the full
// HTTP surface with supertest using real RS256-signed JWTs.
//
// Tenant isolation is verified by issuing tokens with a different tid and
// asserting the row created by tenant A is invisible to tenant B (the
// service explicitly filters by tenant_id).

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';

// ---- env (must come before any import that touches config/env) ----
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

// ---- in-memory store ----
type ReminderRow = {
  id: string;
  tenant_id: string;
  student_id: string | null;
  enrollment_id: string | null;
  type: string;
  title: string;
  description: string | null;
  due_on: Date;
  scheduled_for: Date;
  assigned_to_id: string | null;
  source_entity_type: string | null;
  source_entity_id: string | null;
  status: 'PENDING' | 'SENT' | 'ACKNOWLEDGED' | 'SNOOZED' | 'DISMISSED';
  acknowledged_at: Date | null;
  snooze_until: Date | null;
  deleted_at: Date | null;
  created_by_id: string | null;
  created_at: Date;
  updated_at: Date;
};

const store = { reminders: [] as ReminderRow[] };
const auditCalls: Array<{ action: string; entityId: string | null }> = [];

function resetStore() {
  store.reminders.length = 0;
  auditCalls.length = 0;
}

// ---- prisma mock ----
// The router uses req.db (the RLS-scoped extended client) but the tenantContext
// middleware itself calls prisma.$transaction + tx.$executeRaw. We make the
// extended client a no-op pass-through and route everything to the singleton.
function makePrismaMock() {
  const reminderDelegate = {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const row: ReminderRow = {
        id: randomUUID(),
        tenant_id: String(data['tenant_id']),
        student_id: (data['student_id'] as string | null) ?? null,
        enrollment_id: (data['enrollment_id'] as string | null) ?? null,
        type: String(data['type']),
        title: String(data['title']),
        description: (data['description'] as string | null) ?? null,
        due_on: data['due_on'] as Date,
        scheduled_for: data['scheduled_for'] as Date,
        assigned_to_id: (data['assigned_to_id'] as string | null) ?? null,
        source_entity_type: null,
        source_entity_id: null,
        status: (data['status'] as ReminderRow['status']) ?? 'PENDING',
        acknowledged_at: null,
        snooze_until: null,
        deleted_at: null,
        created_by_id: (data['created_by_id'] as string | null) ?? null,
        created_at: new Date(),
        updated_at: new Date(),
      };
      store.reminders.push(row);
      return row;
    }),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      return (
        store.reminders.find(
          (r) =>
            (where['id'] === undefined || r.id === where['id']) &&
            (where['tenant_id'] === undefined || r.tenant_id === where['tenant_id']) &&
            (where['deleted_at'] === undefined || r.deleted_at === where['deleted_at']),
        ) ?? null
      );
    }),
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      return store.reminders.filter((r) => {
        if (where['tenant_id'] !== undefined && r.tenant_id !== where['tenant_id']) return false;
        if (where['deleted_at'] !== undefined && r.deleted_at !== where['deleted_at']) return false;
        if (where['status'] !== undefined && r.status !== where['status']) return false;
        return true;
      });
    }),
    update: vi.fn(
      async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const r = store.reminders.find((x) => x.id === where.id);
        if (!r) throw new Error('not found');
        Object.assign(r, data, { updated_at: new Date() });
        return r;
      },
    ),
    // SVT-RLS-2026-05: service uses updateMany + findFirstOrThrow.
    updateMany: vi.fn(
      async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        let count = 0;
        for (const r of store.reminders) {
          if (where['id'] !== undefined && r.id !== where['id']) continue;
          if (where['tenant_id'] !== undefined && r.tenant_id !== where['tenant_id']) continue;
          if (where['deleted_at'] !== undefined && r.deleted_at !== where['deleted_at']) continue;
          Object.assign(r, data, { updated_at: new Date() });
          count++;
        }
        return { count };
      },
    ),
    findFirstOrThrow: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const r = store.reminders.find((x) => {
        if (where['id'] !== undefined && x.id !== where['id']) return false;
        if (where['tenant_id'] !== undefined && x.tenant_id !== where['tenant_id']) return false;
        return true;
      });
      if (!r) throw new Error('not found');
      return r;
    }),
  };

  const prisma: Record<string, unknown> = {
    reminder: reminderDelegate,
    accessTokenDenylist: { findUnique: vi.fn(async () => null) },
    auditLog: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({})),
    },
    $transaction: vi.fn(async (fn: unknown) => {
      if (typeof fn === 'function') return (fn as (tx: unknown) => unknown)(prisma);
      return fn;
    }),
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async () => [{ '?column?': 1 }]),
    $extends: vi.fn(() => prisma),
    $disconnect: vi.fn(async () => undefined),
  };
  return prisma;
}

const prismaMock = makePrismaMock();

vi.mock('../src/config/db.js', () => ({
  prisma: prismaMock,
  prismaAdmin: {
    // SVT-QA-2026-08 — `authenticate` reads User.sessions_valid_from through the
    // BYPASS-RLS client (it runs before tenantContext sets the tenant GUC) and
    // fails CLOSED when the lookup throws. null = "no revocation on record".
    user: { findUnique: async () => ({ sessions_valid_from: null }) },
  },
  disconnectDb: async () => undefined,
}));

vi.mock('../src/shared/audit.js', () => ({
  writeAudit: vi.fn(async (...args: unknown[]) => {
    // Accept either writeAudit(event) or writeAudit(req, partial).
    const ev = (args.length === 2 ? args[1] : args[0]) as {
      action: string;
      entityId?: string | null;
      entity_id?: string | null;
    };
    auditCalls.push({
      action: ev.action,
      entityId: ev.entityId ?? ev.entity_id ?? null,
    });
  }),
}));

vi.mock('../src/shared/encryption.js', () => ({
  encryptField: async (s: string | Buffer) =>
    Buffer.from(typeof s === 'string' ? s : s.toString('utf8'), 'utf8'),
  decryptField: async (b: Buffer) => b.toString('utf8'),
  encryptJson: async (v: unknown) => Buffer.from(JSON.stringify(v ?? null), 'utf8'),
  decryptJson: async (b: Buffer) => JSON.parse(b.toString('utf8')),
  isCiphertext: () => true,
}));

vi.mock('../src/shared/hashing.js', async () => {
  const { createHash, createHmac } = await import('node:crypto');
  return {
    sha256Hex: (s: string) => createHash('sha256').update(s).digest('hex'),
    hashIp: (s: string) => createHash('sha256').update(`ip:${s}`).digest('hex'),
    hashUa: (s: string) => createHash('sha256').update(`ua:${s}`).digest('hex'),
    emailHashHmac: (s: string) =>
      createHmac('sha256', 'test-pepper').update(s).digest('hex'),
  };
});

// ---- imports under test (after mocks) ----
const { remindersRouter } = await import('../src/modules/reminders/routes.js');
const { authenticate } = await import('../src/middlewares/auth.js');
const { tenantContext } = await import('../src/middlewares/tenantContext.js');
const { errorHandler, notFoundHandler } = await import('../src/middlewares/errorHandler.js');
const { signAccessToken } = await import('../src/shared/jwt.js');

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/v1/reminders', authenticate, tenantContext, remindersRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TENANT_B = '99999999-9999-7999-8999-999999999999';
const ADMIN_ID = '22222222-2222-7222-8222-222222222222';
const COUNSELLOR_ID = '33333333-3333-7333-8333-333333333333';

async function tokenFor(role: 'ADMIN' | 'COUNSELLOR' | 'VIEWER', tid = TENANT_A) {
  return signAccessToken({
    sub: role === 'ADMIN' ? ADMIN_ID : COUNSELLOR_ID,
    tid,
    role,
    jti: randomUUID(),
  });
}

let app: Express;

beforeAll(() => {
  app = makeApp();
});

beforeEach(() => {
  resetStore();
});

describe('POST /api/v1/reminders', () => {
  it('returns 401 without an Authorization header', async () => {
    const res = await request(app)
      .post('/api/v1/reminders')
      .send({ title: 'X', due_on: '2026-06-15' });
    expect(res.status).toBe(401);
  });

  it('creates a reminder with status PENDING and a UUID id (201)', async () => {
    const tok = await tokenFor('COUNSELLOR');
    const res = await request(app)
      .post('/api/v1/reminders')
      .set('Authorization', `Bearer ${tok}`)
      .send({ title: 'Follow up with student', due_on: '2026-06-15' });
    expect(res.status).toBe(201);
    expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(res.body.status).toBe('PENDING');
    expect(res.body.title).toBe('Follow up with student');
    expect(res.body.tenant_id).toBe(TENANT_A);
    // Audit row was emitted.
    expect(auditCalls.some((c) => c.action === 'reminder.created')).toBe(true);
  });

  it('returns 422 RFC 7807 problem when title is missing', async () => {
    const tok = await tokenFor('COUNSELLOR');
    const res = await request(app)
      .post('/api/v1/reminders')
      .set('Authorization', `Bearer ${tok}`)
      .send({ due_on: '2026-06-15' });
    expect(res.status).toBe(422);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.title).toBe('Unprocessable Entity');
    expect(res.body.status).toBe(422);
    expect(Array.isArray(res.body.errors)).toBe(true);
  });

  it('returns 403 when a VIEWER tries to POST', async () => {
    // Viewer is blocked at the auth middleware (read-only role).
    const tok = await tokenFor('VIEWER');
    const res = await request(app)
      .post('/api/v1/reminders')
      .set('Authorization', `Bearer ${tok}`)
      .send({ title: 'X', due_on: '2026-06-15' });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/v1/reminders', () => {
  it('returns the rows for the calling tenant', async () => {
    const tok = await tokenFor('COUNSELLOR');
    await request(app)
      .post('/api/v1/reminders')
      .set('Authorization', `Bearer ${tok}`)
      .send({ title: 'A', due_on: '2026-06-15' });

    const res = await request(app)
      .get('/api/v1/reminders')
      .set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(200);
    // Standardised list envelope: `{ data: [...], page: { total } }`.
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].title).toBe('A');
    expect(res.body.page?.total).toBe(1);
  });
});

describe('lifecycle: acknowledge / snooze / dismiss', () => {
  it('acknowledge flips status to ACKNOWLEDGED', async () => {
    const tok = await tokenFor('COUNSELLOR');
    const created = await request(app)
      .post('/api/v1/reminders')
      .set('Authorization', `Bearer ${tok}`)
      .send({ title: 'X', due_on: '2026-06-15' });
    const id = created.body.id;

    const res = await request(app)
      .post(`/api/v1/reminders/${id}/acknowledge`)
      .set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ACKNOWLEDGED');
    expect(auditCalls.some((c) => c.action === 'reminder.acknowledged' && c.entityId === id)).toBe(true);
  });

  it('snooze sets snooze_until and status SNOOZED', async () => {
    const tok = await tokenFor('COUNSELLOR');
    const created = await request(app)
      .post('/api/v1/reminders')
      .set('Authorization', `Bearer ${tok}`)
      .send({ title: 'X', due_on: '2026-06-15' });
    const id = created.body.id;
    const until = '2026-06-20T09:00:00.000Z';
    const res = await request(app)
      .post(`/api/v1/reminders/${id}/snooze`)
      .set('Authorization', `Bearer ${tok}`)
      .send({ snooze_until: until });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('SNOOZED');
    expect(new Date(res.body.snooze_until).toISOString()).toBe(until);
  });

  it('dismiss flips status to DISMISSED', async () => {
    const tok = await tokenFor('COUNSELLOR');
    const created = await request(app)
      .post('/api/v1/reminders')
      .set('Authorization', `Bearer ${tok}`)
      .send({ title: 'X', due_on: '2026-06-15' });
    const id = created.body.id;
    const res = await request(app)
      .post(`/api/v1/reminders/${id}/dismiss`)
      .set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('DISMISSED');
  });
});

describe('DELETE /api/v1/reminders/:id', () => {
  it('admin can delete (204)', async () => {
    const counsellorTok = await tokenFor('COUNSELLOR');
    const adminTok = await tokenFor('ADMIN');
    const created = await request(app)
      .post('/api/v1/reminders')
      .set('Authorization', `Bearer ${counsellorTok}`)
      .send({ title: 'X', due_on: '2026-06-15' });
    const id = created.body.id;

    const res = await request(app)
      .delete(`/api/v1/reminders/${id}`)
      .set('Authorization', `Bearer ${adminTok}`);
    expect(res.status).toBe(204);
  });

  it('counsellor cannot delete (403)', async () => {
    const counsellorTok = await tokenFor('COUNSELLOR');
    const created = await request(app)
      .post('/api/v1/reminders')
      .set('Authorization', `Bearer ${counsellorTok}`)
      .send({ title: 'X', due_on: '2026-06-15' });
    const id = created.body.id;
    const res = await request(app)
      .delete(`/api/v1/reminders/${id}`)
      .set('Authorization', `Bearer ${counsellorTok}`);
    expect(res.status).toBe(403);
  });
});

// SVT-FSM-2026-05: terminal-state guard for the reminder lifecycle.
describe('lifecycle FSM guards', () => {
  it('dismissed reminder cannot be re-acknowledged (409)', async () => {
    const tok = await tokenFor('COUNSELLOR');
    const created = await request(app)
      .post('/api/v1/reminders')
      .set('Authorization', `Bearer ${tok}`)
      .send({ title: 'X', due_on: '2026-06-15' });
    const id = created.body.id;

    // First dismiss the row.
    const dismissed = await request(app)
      .post(`/api/v1/reminders/${id}/dismiss`)
      .set('Authorization', `Bearer ${tok}`);
    expect(dismissed.status).toBe(200);
    expect(dismissed.body.status).toBe('DISMISSED');

    // Now try to acknowledge — must be rejected with 409 Conflict.
    const ack = await request(app)
      .post(`/api/v1/reminders/${id}/acknowledge`)
      .set('Authorization', `Bearer ${tok}`);
    expect(ack.status).toBe(409);
    expect(ack.body.detail).toMatch(/Cannot acknowledge a DISMISSED reminder/i);
  });

  it('acknowledged reminder cannot be re-snoozed (409) but can be dismissed (admin tidy-up)', async () => {
    const tok = await tokenFor('COUNSELLOR');
    const created = await request(app)
      .post('/api/v1/reminders')
      .set('Authorization', `Bearer ${tok}`)
      .send({ title: 'Y', due_on: '2026-06-15' });
    const id = created.body.id;

    await request(app)
      .post(`/api/v1/reminders/${id}/acknowledge`)
      .set('Authorization', `Bearer ${tok}`);

    const snz = await request(app)
      .post(`/api/v1/reminders/${id}/snooze`)
      .set('Authorization', `Bearer ${tok}`)
      .send({ snooze_until: '2026-06-20T09:00:00.000Z' });
    expect(snz.status).toBe(409);

    // Dismiss is allowed from ACKNOWLEDGED.
    const dis = await request(app)
      .post(`/api/v1/reminders/${id}/dismiss`)
      .set('Authorization', `Bearer ${tok}`);
    expect(dis.status).toBe(200);
    expect(dis.body.status).toBe('DISMISSED');
  });
});

describe('tenant isolation', () => {
  it("token from tenant B cannot read tenant A's row", async () => {
    const aTok = await tokenFor('COUNSELLOR', TENANT_A);
    const bTok = await tokenFor('COUNSELLOR', TENANT_B);
    const created = await request(app)
      .post('/api/v1/reminders')
      .set('Authorization', `Bearer ${aTok}`)
      .send({ title: 'A-only', due_on: '2026-06-15' });
    const id = created.body.id;

    const res = await request(app)
      .get(`/api/v1/reminders/${id}`)
      .set('Authorization', `Bearer ${bTok}`);
    expect(res.status).toBe(404);
  });
});
