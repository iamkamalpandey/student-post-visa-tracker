// SVT-COMPLIANCE-2026-05 — Resend bounce/complaint webhook tests.
//
// Covers:
//   - Valid signed bounce → flips notifications_email_enabled=false + audit
//   - Valid signed complained → audit row uses spam_complaint action
//   - Unsigned request rejected with 401 (prod-like behavior with secret)
//   - Replay > 5 min rejected
//   - Unknown event types ack 200 with no DB write
//   - Bounce for unknown email logs but doesn't error

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createHmac } from 'node:crypto';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3001');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('JWT_PRIVATE_KEY', '-----BEGIN PRIVATE KEY-----\nstub\n-----END PRIVATE KEY-----');
vi.stubEnv('JWT_PUBLIC_KEY', '-----BEGIN PUBLIC KEY-----\nstub\n-----END PUBLIC KEY-----');
vi.stubEnv('JWT_KID', 'test');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

const SECRET_B64 = Buffer.from('test-secret-32-bytes-of-randomness').toString('base64');

type UserRow = {
  id: string; tenant_id: string; email: string;
  notifications_email_enabled: boolean; deleted_at: Date | null;
};

const store = { users: [] as UserRow[] };
const auditCalls: Array<Record<string, unknown>> = [];

vi.mock('../src/config/db.js', () => {
  const prisma = {
    user: {
      findMany: vi.fn(async ({ where }: { where: { email: string; deleted_at: null } }) =>
        store.users.filter((u) => u.email === where.email && u.deleted_at == null)),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const u = store.users.find((x) => x.id === where.id);
        if (u) Object.assign(u, data);
        return u;
      }),
    },
  };

  // SVT-SEC-2026-08 (T0-7) — these paths now scope their queries: cross-tenant
  // discovery reads use prismaAdmin, and everything with a known tenant runs
  // inside withTenantTx, which opens a transaction and sets the app.tenant_id
  // GUC first. Without the GUC the RLS policies match zero rows under the
  // production role, so the code silently did nothing.
  (prisma as Record<string, unknown>)['$transaction'] =
    vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma));
  (prisma as Record<string, unknown>)['$executeRaw'] = vi.fn(async () => 1);

  return { prisma, prismaAdmin: prisma, disconnectDb: async () => undefined };
});

vi.mock('../src/shared/audit.js', () => ({
  writeAudit: vi.fn(async (e: Record<string, unknown>) => { auditCalls.push(e); }),
}));

process.env['RESEND_WEBHOOK_SECRET'] = SECRET_B64;

const { webhooksRouter } = await import('../src/modules/comms/webhooks.routes.js');

function makeApp() {
  const app = express();
  app.use('/api/v1/webhooks', webhooksRouter);
  return app;
}

function signEvent(id: string, ts: number, body: string): string {
  const payload = `${id}.${ts}.${body}`;
  const sig = createHmac('sha256', Buffer.from(SECRET_B64, 'base64')).update(payload).digest('base64');
  return `v1,${sig}`;
}

const USER_ID = '11111111-1111-7111-8111-111111111111';

beforeEach(() => {
  store.users.length = 0;
  auditCalls.length = 0;
  store.users.push({
    id: USER_ID,
    tenant_id: '22222222-2222-7222-8222-222222222222',
    email: 'alice@example.com',
    notifications_email_enabled: true,
    deleted_at: null,
  });
});

describe('POST /api/v1/webhooks/resend', () => {
  it('valid signed bounce flips notifications_email_enabled=false + audits', async () => {
    const body = JSON.stringify({
      type: 'email.bounced',
      data: { to: 'alice@example.com', email_id: 'r-1' },
    });
    const ts = Math.floor(Date.now() / 1000);
    const sig = signEvent('evt-1', ts, body);
    const res = await request(makeApp())
      .post('/api/v1/webhooks/resend')
      .set('content-type', 'application/json')
      .set('svix-id', 'evt-1')
      .set('svix-timestamp', String(ts))
      .set('svix-signature', sig)
      .send(body);
    expect(res.status).toBe(200);
    expect(store.users[0]!.notifications_email_enabled).toBe(false);
    expect(auditCalls.some((c) => c.action === 'comms.bounced')).toBe(true);
  });

  it('valid signed spam complaint audits as comms.spam_complaint', async () => {
    const body = JSON.stringify({
      type: 'email.complained',
      data: { to: 'alice@example.com' },
    });
    const ts = Math.floor(Date.now() / 1000);
    const sig = signEvent('evt-2', ts, body);
    const res = await request(makeApp())
      .post('/api/v1/webhooks/resend')
      .set('svix-id', 'evt-2')
      .set('svix-timestamp', String(ts))
      .set('svix-signature', sig)
      .send(body);
    expect(res.status).toBe(200);
    expect(auditCalls.some((c) => c.action === 'comms.spam_complaint')).toBe(true);
  });

  it('rejects bad signature with 401', async () => {
    const body = JSON.stringify({ type: 'email.bounced', data: { to: 'alice@example.com' } });
    const ts = Math.floor(Date.now() / 1000);
    const res = await request(makeApp())
      .post('/api/v1/webhooks/resend')
      .set('svix-id', 'evt-3')
      .set('svix-timestamp', String(ts))
      .set('svix-signature', 'v1,deadbeef')
      .send(body);
    expect(res.status).toBe(401);
    expect(store.users[0]!.notifications_email_enabled).toBe(true);
  });

  it('rejects replay older than 5 min', async () => {
    const body = JSON.stringify({ type: 'email.bounced', data: { to: 'alice@example.com' } });
    const ts = Math.floor(Date.now() / 1000) - 400; // 400s ago
    const sig = signEvent('evt-4', ts, body);
    const res = await request(makeApp())
      .post('/api/v1/webhooks/resend')
      .set('svix-id', 'evt-4')
      .set('svix-timestamp', String(ts))
      .set('svix-signature', sig)
      .send(body);
    expect(res.status).toBe(401);
  });

  it('unknown event types ack 200 with no mutation', async () => {
    const body = JSON.stringify({
      type: 'email.delivered',
      data: { to: 'alice@example.com' },
    });
    const ts = Math.floor(Date.now() / 1000);
    const sig = signEvent('evt-5', ts, body);
    const res = await request(makeApp())
      .post('/api/v1/webhooks/resend')
      .set('svix-id', 'evt-5')
      .set('svix-timestamp', String(ts))
      .set('svix-signature', sig)
      .send(body);
    expect(res.status).toBe(200);
    expect(store.users[0]!.notifications_email_enabled).toBe(true);
    expect(auditCalls).toHaveLength(0);
  });

  it('bounce for unknown email is 200 + no error', async () => {
    const body = JSON.stringify({
      type: 'email.bounced',
      data: { to: 'nobody@example.com' },
    });
    const ts = Math.floor(Date.now() / 1000);
    const sig = signEvent('evt-6', ts, body);
    const res = await request(makeApp())
      .post('/api/v1/webhooks/resend')
      .set('svix-id', 'evt-6')
      .set('svix-timestamp', String(ts))
      .set('svix-signature', sig)
      .send(body);
    expect(res.status).toBe(200);
  });

  it('idempotent: second bounce on already-suppressed user does NOT double-audit', async () => {
    store.users[0]!.notifications_email_enabled = false;
    const body = JSON.stringify({
      type: 'email.bounced',
      data: { to: 'alice@example.com' },
    });
    const ts = Math.floor(Date.now() / 1000);
    const sig = signEvent('evt-7', ts, body);
    const res = await request(makeApp())
      .post('/api/v1/webhooks/resend')
      .set('svix-id', 'evt-7')
      .set('svix-timestamp', String(ts))
      .set('svix-signature', sig)
      .send(body);
    expect(res.status).toBe(200);
    expect(auditCalls).toHaveLength(0);
  });
});

// SVT-AUDIT-SEC-2026-06 (backlog rank 1) — regression: the PRODUCTION app mounts
// a global express.json() BEFORE the webhook router. That parser consumes the
// body (sets req._body) so the webhook's own raw() parser is skipped and the
// HMAC was being computed over a re-stringified object → every signed webhook
// 401'd in prod. The isolated makeApp() above masked it (no global parser).
// These tests mirror the real middleware ordering: global json with the
// rawBody-capturing `verify` callback, THEN the webhook router.
function makeAppWithGlobalJson() {
  const app = express();
  app.use(
    express.json({
      limit: '256kb',
      strict: true,
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use('/api/v1/webhooks', webhooksRouter);
  return app;
}

describe('POST /api/v1/webhooks/resend behind the global JSON parser (prod ordering)', () => {
  it('valid signed bounce still verifies + flips the flag (was 401 before the fix)', async () => {
    const body = JSON.stringify({
      type: 'email.bounced',
      data: { to: 'alice@example.com', email_id: 'r-prod-1' },
    });
    const ts = Math.floor(Date.now() / 1000);
    const sig = signEvent('evt-prod-1', ts, body);
    const res = await request(makeAppWithGlobalJson())
      .post('/api/v1/webhooks/resend')
      .set('content-type', 'application/json')
      .set('svix-id', 'evt-prod-1')
      .set('svix-timestamp', String(ts))
      .set('svix-signature', sig)
      .send(body);
    expect(res.status).toBe(200);
    expect(store.users[0]!.notifications_email_enabled).toBe(false);
    expect(auditCalls.some((c) => c.action === 'comms.bounced')).toBe(true);
  });

  it('tampered signature still 401s through the global parser', async () => {
    const body = JSON.stringify({ type: 'email.bounced', data: { to: 'alice@example.com' } });
    const ts = Math.floor(Date.now() / 1000);
    const res = await request(makeAppWithGlobalJson())
      .post('/api/v1/webhooks/resend')
      .set('content-type', 'application/json')
      .set('svix-id', 'evt-prod-2')
      .set('svix-timestamp', String(ts))
      .set('svix-signature', 'v1,deadbeef')
      .send(body);
    expect(res.status).toBe(401);
    expect(store.users[0]!.notifications_email_enabled).toBe(true);
  });
});
