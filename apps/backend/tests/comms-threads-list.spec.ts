// SVT-WAVE19-THREADS-2026-05 — per-tenant thread list endpoint.

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

type ThreadRow = {
  id: string; tenant_id: string; student_id: string | null;
  channel: string; subject: string | null; created_at: Date;
  student?: { id: string; given_name: string; family_name: string; student_code: string } | null;
};
type MsgRow = {
  id: string; tenant_id: string; thread_id: string; subject: string | null;
  body: string; created_at: Date; status: string; direction: string;
  recipient_user_id: string | null; read_at: Date | null;
};

const store = { threads: [] as ThreadRow[], messages: [] as MsgRow[] };

vi.mock('../src/config/db.js', () => {
  const prisma = {
    commsThread: {
      findMany: vi.fn(async ({ where, take }: { where: Record<string, unknown>; take?: number }) => {
        let rows = store.threads.filter((t) => t.tenant_id === where['tenant_id']);
        if (where['channel']) rows = rows.filter((t) => t.channel === where['channel']);
        if (where['student_id']) rows = rows.filter((t) => t.student_id === where['student_id']);
        // Crude OR-clause evaluator that mirrors the production Prisma query
        // shape used by /comms/threads?q=... — substring match on subject or
        // any student name field. Good enough to exercise the controller path.
        if (Array.isArray(where['OR'])) {
          const ors = where['OR'] as Array<Record<string, unknown>>;
          rows = rows.filter((t) =>
            ors.some((clause) => {
              const sub = clause['subject'] as { contains?: string } | undefined;
              if (sub?.contains) {
                return (t.subject ?? '').toLowerCase().includes(sub.contains.toLowerCase());
              }
              const stu = clause['student'] as { is?: Record<string, { contains?: string }> } | undefined;
              if (stu?.is) {
                for (const [field, cond] of Object.entries(stu.is)) {
                  const needle = (cond as { contains?: string }).contains;
                  const haystack = (t.student as Record<string, string | undefined> | null | undefined)?.[field];
                  if (needle && haystack && haystack.toLowerCase().includes(needle.toLowerCase())) return true;
                }
              }
              return false;
            }),
          );
        }
        rows = rows.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
        return take ? rows.slice(0, take) : rows;
      }),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return store.threads.find((t) => t.id === where['id'] && t.tenant_id === where['tenant_id']) ?? null;
      }),
    },
    commsMessage: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const tid = where['thread_id'];
        let rows = store.messages.slice();
        if (tid && typeof tid === 'object' && 'in' in (tid as object)) {
          const ids = (tid as { in: string[] }).in;
          const idSet = new Set(ids);
          rows = rows.filter((m) => idSet.has(m.thread_id));
        } else if (typeof tid === 'string') {
          rows = rows.filter((m) => m.thread_id === tid);
        }
        return rows.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
      }),
      groupBy: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const ids = (where['thread_id'] as { in: string[] })?.in ?? [];
        const filtered = store.messages.filter((m) =>
          ids.includes(m.thread_id) &&
          m.recipient_user_id === where['recipient_user_id'] &&
          m.read_at == null,
        );
        const buckets = new Map<string, number>();
        for (const m of filtered) buckets.set(m.thread_id, (buckets.get(m.thread_id) ?? 0) + 1);
        return Array.from(buckets, ([thread_id, c]) => ({ thread_id, _count: { _all: c } }));
      }),
      // For middleware fail-closed JTI check.
      findUnique: vi.fn(async () => null),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        let count = 0;
        for (const m of store.messages) {
          if (m.tenant_id !== where['tenant_id']) continue;
          if (m.thread_id !== where['thread_id']) continue;
          if (m.recipient_user_id !== where['recipient_user_id']) continue;
          if (where['read_at'] === null && m.read_at != null) continue;
          for (const [k, v] of Object.entries(data)) (m as Record<string, unknown>)[k] = v as never;
          count += 1;
        }
        return { count };
      }),
    },
    accessTokenDenylist: { findUnique: vi.fn(async () => null) },
    $extends: vi.fn(function (this: unknown) { return prisma; }),
    $transaction: vi.fn(async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma)),
    $executeRaw: vi.fn(async () => 1),
  };
  return { prisma, disconnectDb: async () => undefined };
});

const { authenticate } = await import('../src/middlewares/auth.js');
const { tenantContext } = await import('../src/middlewares/tenantContext.js');
const { errorHandler, notFoundHandler } = await import('../src/middlewares/errorHandler.js');
const { commsThreadsRouter } = await import('../src/modules/comms/routes.js');
const { signAccessToken } = await import('../src/shared/jwt.js');

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/comms/threads', authenticate, tenantContext, commsThreadsRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

let app: Express;
let token: string;

beforeEach(async () => {
  store.threads.length = 0;
  store.messages.length = 0;
  if (!app) app = makeApp();
  if (!token) {
    token = await signAccessToken({ sub: USER, tid: TENANT, role: 'ADMIN', jti: randomUUID() });
  }
});

function seedThread(opts: Partial<ThreadRow> = {}): ThreadRow {
  const t: ThreadRow = {
    id: randomUUID(), tenant_id: TENANT, student_id: 'student-1',
    channel: 'EMAIL', subject: 'Hi', created_at: new Date(),
    student: { id: 'student-1', given_name: 'Maya', family_name: 'Patel', student_code: 'SPV-2026-000001' },
    ...opts,
  };
  store.threads.push(t);
  return t;
}

function seedMsg(thread: ThreadRow, opts: Partial<MsgRow> = {}): MsgRow {
  const m: MsgRow = {
    id: randomUUID(), tenant_id: TENANT, thread_id: thread.id, subject: null,
    body: 'hello', created_at: new Date(), status: 'SENT', direction: 'OUTBOUND',
    recipient_user_id: USER, read_at: new Date(),
    ...opts,
  };
  store.messages.push(m);
  return m;
}

describe('GET /api/v1/comms/threads', () => {
  it('returns 401 without bearer', async () => {
    const res = await request(app).get('/api/v1/comms/threads');
    expect(res.status).toBe(401);
  });

  it('returns threads with embedded last_message + unread_count', async () => {
    const t = seedThread();
    seedMsg(t, { body: 'old', created_at: new Date(Date.now() - 60_000), read_at: new Date() });
    seedMsg(t, { body: 'newest', created_at: new Date(), read_at: null });
    const res = await request(app).get('/api/v1/comms/threads').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].last_message.body).toBe('newest');
    expect(res.body.data[0].unread_count).toBe(1);
  });

  it('channel filter narrows to one channel', async () => {
    seedThread({ channel: 'EMAIL' });
    seedThread({ channel: 'SMS' });
    const res = await request(app).get('/api/v1/comms/threads?channel=SMS').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].channel).toBe('SMS');
  });

  it('returns empty data for no threads', async () => {
    const res = await request(app).get('/api/v1/comms/threads').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('unread_count is 0 when no messages match recipient', async () => {
    const t = seedThread();
    seedMsg(t, { recipient_user_id: 'other-user', read_at: null });
    const res = await request(app).get('/api/v1/comms/threads').set('Authorization', `Bearer ${token}`);
    expect(res.body.data[0].unread_count).toBe(0);
  });

  // SVT-WAVE29-THREAD-SEARCH-2026-05
  it('q filter matches against thread subject (case-insensitive)', async () => {
    seedThread({ subject: 'Visa renewal — September intake' });
    seedThread({ subject: 'Tuition deposit due' });
    const res = await request(app)
      .get('/api/v1/comms/threads?q=visa')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].subject).toContain('Visa');
  });

  it('q filter matches against student given/family name', async () => {
    seedThread({
      subject: null,
      student: { id: 's1', given_name: 'Maya', family_name: 'Patel', student_code: 'SPV-2026-000001' },
    });
    seedThread({
      subject: null,
      student: { id: 's2', given_name: 'Liam', family_name: 'Carter', student_code: 'SPV-2026-000002' },
    });
    const res = await request(app)
      .get('/api/v1/comms/threads?q=carter')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].student.family_name).toBe('Carter');
  });

  it('q filter returns empty when nothing matches', async () => {
    seedThread({ subject: 'Visa renewal' });
    const res = await request(app)
      .get('/api/v1/comms/threads?q=tuition')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('q filter combines with channel filter (intersection)', async () => {
    seedThread({ channel: 'EMAIL', subject: 'Visa renewal' });
    seedThread({ channel: 'SMS', subject: 'Visa renewal' });
    const res = await request(app)
      .get('/api/v1/comms/threads?q=visa&channel=SMS')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].channel).toBe('SMS');
  });
});

// SVT-WAVE20-THREADS-DETAIL-2026-05 — thread drill-in with auto-mark-read.
describe('GET /api/v1/comms/threads/:id', () => {
  it('returns thread + messages + newly_read count', async () => {
    const t = seedThread();
    seedMsg(t, { body: 'msg1', recipient_user_id: USER, read_at: null });
    seedMsg(t, { body: 'msg2', recipient_user_id: USER, read_at: null });
    seedMsg(t, { body: 'already-read', recipient_user_id: USER, read_at: new Date() });
    const res = await request(app)
      .get(`/api/v1/comms/threads/${t.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.thread.id).toBe(t.id);
    expect(res.body.data.messages).toHaveLength(3);
    expect(res.body.data.newly_read).toBe(2);
    // After the open, every recipient=me row has read_at set.
    const unread = store.messages.filter((m) => m.recipient_user_id === USER && m.read_at == null);
    expect(unread).toHaveLength(0);
  });

  it('returns 404 for an unknown thread id', async () => {
    const res = await request(app)
      .get('/api/v1/comms/threads/aaaaaaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});
