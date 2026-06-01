// Checklist module integration tests.
//
// Covers the three routers:
//   - stageChecklistItemsRouter      /stages/:stageId/checklist-items
//   - stageChecklistItemFlatRouter   /stages/checklist-items/:id
//   - studentChecklistProgressRouter /students/:studentId/checklist-progress
//
// We mount each router behind authenticate + tenantContext so the tests mirror
// the full HTTP surface app.ts wires together. Prisma is mocked with an in-
// memory store; lifecycle stages and students are pre-seeded since the service
// validates their existence before doing anything.

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

type StageRow = { id: string; tenant_id: string };
type ItemRow = {
  id: string;
  tenant_id: string;
  stage_id: string;
  label: string;
  description: string | null;
  sequence: number;
  is_required: boolean;
  sla_hours: number | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
};
type ProgressRow = {
  id: string;
  tenant_id: string;
  student_id: string;
  stage_id: string;
  checklist_item_id: string;
  completed_at: Date | null;
  completed_by_id: string | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
};
type StudentRow = { id: string; tenant_id: string; deleted_at: Date | null };

const store = {
  stages: [] as StageRow[],
  items: [] as ItemRow[],
  progress: [] as ProgressRow[],
  students: [] as StudentRow[],
};
const auditCalls: Array<{ action: string; entityId: string | null }> = [];

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TENANT_B = '99999999-9999-7999-8999-999999999999';
const ADMIN_ID = '22222222-2222-7222-8222-222222222222';
const COUNSELLOR_ID = '33333333-3333-7333-8333-333333333333';
const STAGE_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const STUDENT_ID = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';

function resetStore() {
  store.stages.length = 0;
  store.items.length = 0;
  store.progress.length = 0;
  store.students.length = 0;
  auditCalls.length = 0;
  // Default fixtures: a stage and a student in tenant A.
  store.stages.push({ id: STAGE_ID, tenant_id: TENANT_A });
  store.students.push({ id: STUDENT_ID, tenant_id: TENANT_A, deleted_at: null });
}

function makePrismaMock() {
  const stageDelegate = {
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      return (
        store.stages.find(
          (s) =>
            (where['id'] === undefined || s.id === where['id']) &&
            (where['tenant_id'] === undefined || s.tenant_id === where['tenant_id']),
        ) ?? null
      );
    }),
  };

  const itemDelegate = {
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      return (
        store.items.find(
          (r) =>
            (where['id'] === undefined || r.id === where['id']) &&
            (where['tenant_id'] === undefined || r.tenant_id === where['tenant_id']) &&
            (where['deleted_at'] === undefined || r.deleted_at === where['deleted_at']),
        ) ?? null
      );
    }),
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      return store.items
        .filter((r) => {
          if (where['tenant_id'] !== undefined && r.tenant_id !== where['tenant_id']) return false;
          if (where['stage_id'] !== undefined && r.stage_id !== where['stage_id']) return false;
          if (where['deleted_at'] !== undefined && r.deleted_at !== where['deleted_at']) return false;
          if (where['is_active'] !== undefined && r.is_active !== where['is_active']) return false;
          return true;
        })
        .sort((a, b) => a.sequence - b.sequence);
    }),
    aggregate: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const rows = store.items.filter((r) => {
        if (where['stage_id'] !== undefined && r.stage_id !== where['stage_id']) return false;
        if (where['deleted_at'] !== undefined && r.deleted_at !== where['deleted_at']) return false;
        return true;
      });
      const max = rows.length ? Math.max(...rows.map((r) => r.sequence)) : null;
      return { _max: { sequence: max } };
    }),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const row: ItemRow = {
        id: randomUUID(),
        tenant_id: String(data['tenant_id']),
        stage_id: String(data['stage_id']),
        label: String(data['label']),
        description: (data['description'] as string | null) ?? null,
        sequence: Number(data['sequence'] ?? 0),
        is_required: Boolean(data['is_required'] ?? true),
        sla_hours: (data['sla_hours'] as number | null) ?? null,
        is_active: Boolean(data['is_active'] ?? true),
        created_at: new Date(),
        updated_at: new Date(),
        deleted_at: null,
      };
      store.items.push(row);
      return row;
    }),
    update: vi.fn(
      async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const r = store.items.find((x) => x.id === where.id);
        if (!r) throw new Error('not found');
        Object.assign(r, data, { updated_at: new Date() });
        return r;
      },
    ),
    findFirstOrThrow: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const r = store.items.find((x) => {
        if (where['id'] !== undefined && x.id !== where['id']) return false;
        if (where['tenant_id'] !== undefined && x.tenant_id !== where['tenant_id']) return false;
        return true;
      });
      if (!r) throw new Error('not found');
      return r;
    }),
    updateMany: vi.fn(
      async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        let count = 0;
        for (const r of store.items) {
          if (where['id'] !== undefined && r.id !== where['id']) continue;
          if (where['tenant_id'] !== undefined && r.tenant_id !== where['tenant_id']) continue;
          if (where['deleted_at'] !== undefined && r.deleted_at !== where['deleted_at']) continue;
          Object.assign(r, data, { updated_at: new Date() });
          count++;
        }
        return { count };
      },
    ),
  };

  const progressDelegate = {
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      return store.progress.filter((p) => {
        if (where['tenant_id'] !== undefined && p.tenant_id !== where['tenant_id']) return false;
        if (where['student_id'] !== undefined && p.student_id !== where['student_id']) return false;
        if (where['stage_id'] !== undefined && p.stage_id !== where['stage_id']) return false;
        return true;
      });
    }),
    upsert: vi.fn(
      async ({
        where,
        create,
        update,
      }: {
        where: { student_id_checklist_item_id: { student_id: string; checklist_item_id: string } };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const k = where.student_id_checklist_item_id;
        const existing = store.progress.find(
          (p) => p.student_id === k.student_id && p.checklist_item_id === k.checklist_item_id,
        );
        if (existing) {
          Object.assign(existing, update, { updated_at: new Date() });
          return existing;
        }
        const row: ProgressRow = {
          id: randomUUID(),
          tenant_id: String(create['tenant_id']),
          student_id: String(create['student_id']),
          stage_id: String(create['stage_id']),
          checklist_item_id: String(create['checklist_item_id']),
          completed_at: (create['completed_at'] as Date | null) ?? null,
          completed_by_id: (create['completed_by_id'] as string | null) ?? null,
          notes: (create['notes'] as string | null) ?? null,
          created_at: new Date(),
          updated_at: new Date(),
        };
        store.progress.push(row);
        return row;
      },
    ),
  };

  const studentDelegate = {
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      return (
        store.students.find(
          (s) =>
            (where['id'] === undefined || s.id === where['id']) &&
            (where['tenant_id'] === undefined || s.tenant_id === where['tenant_id']) &&
            (where['deleted_at'] === undefined || s.deleted_at === where['deleted_at']),
        ) ?? null
      );
    }),
  };

  const prisma: Record<string, unknown> = {
    lifecycleStage: stageDelegate,
    lifecycleStageChecklistItem: itemDelegate,
    studentStageChecklistProgress: progressDelegate,
    student: studentDelegate,
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
  disconnectDb: async () => undefined,
}));

vi.mock('../src/shared/audit.js', () => ({
  writeAudit: vi.fn(async (...args: unknown[]) => {
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

const {
  stageChecklistItemsRouter,
  stageChecklistItemFlatRouter,
  studentChecklistProgressRouter,
} = await import('../src/modules/checklist/routes.js');
const { errorHandler, notFoundHandler } = await import('../src/middlewares/errorHandler.js');
const { signAccessToken } = await import('../src/shared/jwt.js');

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  // Mount BEFORE the flat router so /stages/checklist-items/:id doesn't get
  // shadowed (matches app.ts order).
  app.use('/api/v1/stages/:stageId/checklist-items', stageChecklistItemsRouter);
  app.use('/api/v1/stages/checklist-items', stageChecklistItemFlatRouter);
  app.use('/api/v1/students/:studentId/checklist-progress', studentChecklistProgressRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

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

describe('GET /api/v1/stages/:stageId/checklist-items', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get(`/api/v1/stages/${STAGE_ID}/checklist-items`);
    expect(res.status).toBe(401);
  });

  it('returns 200 {data: []} for an empty stage', async () => {
    const tok = await tokenFor('COUNSELLOR');
    const res = await request(app)
      .get(`/api/v1/stages/${STAGE_ID}/checklist-items`)
      .set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [] });
  });
});

describe('POST /api/v1/stages/:stageId/checklist-items', () => {
  it('admin creates an item (201)', async () => {
    const tok = await tokenFor('ADMIN');
    const res = await request(app)
      .post(`/api/v1/stages/${STAGE_ID}/checklist-items`)
      .set('Authorization', `Bearer ${tok}`)
      .send({ label: 'Upload passport scan' });
    expect(res.status).toBe(201);
    expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(res.body.label).toBe('Upload passport scan');
    expect(auditCalls.some((c) => c.action === 'stage_checklist_item.created')).toBe(true);
  });

  it('viewer cannot POST (403)', async () => {
    const tok = await tokenFor('VIEWER');
    const res = await request(app)
      .post(`/api/v1/stages/${STAGE_ID}/checklist-items`)
      .set('Authorization', `Bearer ${tok}`)
      .send({ label: 'X' });
    expect(res.status).toBe(403);
  });

  it('missing label returns 422 RFC 7807', async () => {
    const tok = await tokenFor('ADMIN');
    const res = await request(app)
      .post(`/api/v1/stages/${STAGE_ID}/checklist-items`)
      .set('Authorization', `Bearer ${tok}`)
      .send({});
    expect(res.status).toBe(422);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  });
});

describe('PATCH /api/v1/stages/checklist-items/:id', () => {
  it('updates description and sequence (200)', async () => {
    const tok = await tokenFor('ADMIN');
    const created = await request(app)
      .post(`/api/v1/stages/${STAGE_ID}/checklist-items`)
      .set('Authorization', `Bearer ${tok}`)
      .send({ label: 'X' });
    const id = created.body.id;
    const res = await request(app)
      .patch(`/api/v1/stages/checklist-items/${id}`)
      .set('Authorization', `Bearer ${tok}`)
      .send({ description: 'New desc', sequence: 5 });
    expect(res.status).toBe(200);
    expect(res.body.description).toBe('New desc');
    expect(res.body.sequence).toBe(5);
    expect(auditCalls.some((c) => c.action === 'stage_checklist_item.updated')).toBe(true);
  });
});

describe('DELETE /api/v1/stages/checklist-items/:id', () => {
  it('admin soft-deletes (204) and the item disappears from list', async () => {
    const adminTok = await tokenFor('ADMIN');
    const created = await request(app)
      .post(`/api/v1/stages/${STAGE_ID}/checklist-items`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ label: 'X' });
    const id = created.body.id;
    const del = await request(app)
      .delete(`/api/v1/stages/checklist-items/${id}`)
      .set('Authorization', `Bearer ${adminTok}`);
    expect(del.status).toBe(204);
    // deleted_at is set in-store -> findMany excludes the row.
    const row = store.items.find((i) => i.id === id)!;
    expect(row.deleted_at).not.toBeNull();
    const list = await request(app)
      .get(`/api/v1/stages/${STAGE_ID}/checklist-items`)
      .set('Authorization', `Bearer ${adminTok}`);
    expect((list.body.data as Array<{ id: string }>).find((r) => r.id === id)).toBeUndefined();
  });

  it('counsellor cannot delete (403)', async () => {
    const adminTok = await tokenFor('ADMIN');
    const counsellorTok = await tokenFor('COUNSELLOR');
    const created = await request(app)
      .post(`/api/v1/stages/${STAGE_ID}/checklist-items`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ label: 'X' });
    const id = created.body.id;
    const res = await request(app)
      .delete(`/api/v1/stages/checklist-items/${id}`)
      .set('Authorization', `Bearer ${counsellorTok}`);
    expect(res.status).toBe(403);
  });
});

describe('POST /api/v1/students/:studentId/checklist-progress', () => {
  it('upserts progress, sets completed_at, idempotent on second call', async () => {
    const adminTok = await tokenFor('ADMIN');
    const created = await request(app)
      .post(`/api/v1/stages/${STAGE_ID}/checklist-items`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ label: 'Upload passport' });
    const itemId = created.body.id;

    const first = await request(app)
      .post(`/api/v1/students/${STUDENT_ID}/checklist-progress`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ checklist_item_id: itemId, completed: true });
    expect(first.status).toBe(200);
    expect(first.body.completed_at).toBeTruthy();
    const firstId = first.body.id;
    expect(auditCalls.some((c) => c.action === 'stage_checklist_progress.complete')).toBe(true);

    // Re-POST with same (student, item) does NOT create a duplicate row.
    const second = await request(app)
      .post(`/api/v1/students/${STUDENT_ID}/checklist-progress`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ checklist_item_id: itemId, completed: true });
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(firstId);
    expect(store.progress.length).toBe(1);
  });

  it('completed: false clears completed_at', async () => {
    const adminTok = await tokenFor('ADMIN');
    const created = await request(app)
      .post(`/api/v1/stages/${STAGE_ID}/checklist-items`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ label: 'Upload passport' });
    const itemId = created.body.id;
    await request(app)
      .post(`/api/v1/students/${STUDENT_ID}/checklist-progress`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ checklist_item_id: itemId, completed: true });
    const res = await request(app)
      .post(`/api/v1/students/${STUDENT_ID}/checklist-progress`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ checklist_item_id: itemId, completed: false });
    expect(res.status).toBe(200);
    expect(res.body.completed_at).toBeNull();
    expect(auditCalls.some((c) => c.action === 'stage_checklist_progress.uncomplete')).toBe(true);
  });

  it('viewer cannot POST progress (403)', async () => {
    const tok = await tokenFor('VIEWER');
    const res = await request(app)
      .post(`/api/v1/students/${STUDENT_ID}/checklist-progress`)
      .set('Authorization', `Bearer ${tok}`)
      .send({ checklist_item_id: STAGE_ID, completed: true });
    expect(res.status).toBe(403);
  });
});

describe('tenant isolation', () => {
  it("token from tenant B cannot see tenant A stage's items", async () => {
    const aTok = await tokenFor('ADMIN', TENANT_A);
    const bTok = await tokenFor('ADMIN', TENANT_B);
    await request(app)
      .post(`/api/v1/stages/${STAGE_ID}/checklist-items`)
      .set('Authorization', `Bearer ${aTok}`)
      .send({ label: 'X' });
    // The stage exists in tenant A only; tenant B's findFirst returns null and
    // service throws 404.
    const res = await request(app)
      .get(`/api/v1/stages/${STAGE_ID}/checklist-items`)
      .set('Authorization', `Bearer ${bTok}`);
    expect(res.status).toBe(404);
  });
});
