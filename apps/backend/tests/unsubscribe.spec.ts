// SVT-COMPLIANCE-2026-05 — One-click unsubscribe (RFC 8058) tests.
//
// Covers:
//   - GET with valid token → 200 HTML + user flag flipped
//   - GET with bad token → 200 HTML, NO mutation (anti-enumeration)
//   - GET with unknown user_id → 200 HTML, no error leak
//   - POST One-Click target → 200 empty body, user flipped
//   - Already-unsubscribed user → 200 idempotent (no double-audit)
//   - buildUnsubscribeUrl produces the URL the endpoint accepts (round-trip)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3001');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('JWT_PRIVATE_KEY', 'unit-test-hmac-secret');
vi.stubEnv('JWT_PUBLIC_KEY', '-----BEGIN PUBLIC KEY-----\nstub\n-----END PUBLIC KEY-----');
vi.stubEnv('JWT_KID', 'test');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

type UserRow = {
  id: string;
  tenant_id: string;
  notifications_email_enabled: boolean;
  deleted_at: Date | null;
};

const store = { users: [] as UserRow[] };
const auditCalls: Array<Record<string, unknown>> = [];

vi.mock('../src/config/db.js', () => {
  const prisma = {
    user: {
      findFirst: vi.fn(async ({ where }: { where: { id?: string; deleted_at?: null } }) =>
        store.users.find((u) => u.id === where.id && u.deleted_at == null) ?? null),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const u = store.users.find((x) => x.id === where.id);
        if (u) Object.assign(u, data);
        return u;
      }),
    },
  };
  return { prisma, disconnectDb: async () => undefined };
});

vi.mock('../src/shared/audit.js', () => ({
  writeAudit: vi.fn(async (event: Record<string, unknown>) => { auditCalls.push(event); }),
}));

const { unsubscribeRouter, buildUnsubscribeUrl } = await import(
  '../src/modules/comms/unsubscribe.routes.js'
);

function makeApp() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use('/api/v1/comms/unsubscribe', unsubscribeRouter);
  return app;
}

const USER_ID = '11111111-1111-7111-8111-111111111111';
const TENANT_ID = '22222222-2222-7222-8222-222222222222';

beforeEach(() => {
  store.users.length = 0;
  store.users.push({
    id: USER_ID,
    tenant_id: TENANT_ID,
    notifications_email_enabled: true,
    deleted_at: null,
  });
  auditCalls.length = 0;
});

describe('comms/unsubscribe', () => {
  it('buildUnsubscribeUrl returns a URL the endpoint accepts', async () => {
    const url = buildUnsubscribeUrl('https://api.example.com', USER_ID);
    expect(url).toMatch(/^https:\/\/api\.example\.com\/api\/v1\/comms\/unsubscribe\?u=[^&]+&t=[a-f0-9]{64}$/);
    const params = new URL(url).searchParams;
    expect(params.get('u')).toBe(USER_ID);
    const res = await request(makeApp())
      .get('/api/v1/comms/unsubscribe')
      .query({ u: params.get('u'), t: params.get('t') });
    expect(res.status).toBe(200);
    expect(store.users[0]!.notifications_email_enabled).toBe(false);
  });

  it('GET with bad token returns 200 HTML and does NOT flip the flag', async () => {
    const res = await request(makeApp())
      .get('/api/v1/comms/unsubscribe')
      .query({ u: USER_ID, t: 'a'.repeat(64) });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(store.users[0]!.notifications_email_enabled).toBe(true);
    expect(auditCalls).toHaveLength(0);
  });

  it('GET with unknown user returns 200 with no leak', async () => {
    const validToken = (await import('node:crypto'))
      .createHmac('sha256', 'unit-test-hmac-secret')
      .update('99999999-9999-7999-8999-999999999999')
      .digest('hex');
    const res = await request(makeApp())
      .get('/api/v1/comms/unsubscribe')
      .query({ u: '99999999-9999-7999-8999-999999999999', t: validToken });
    expect(res.status).toBe(200);
    expect(auditCalls).toHaveLength(0);
  });

  it('POST one-click endpoint returns 200 empty and flips flag', async () => {
    const url = buildUnsubscribeUrl('http://localhost', USER_ID);
    const params = new URL(url).searchParams;
    const res = await request(makeApp())
      .post('/api/v1/comms/unsubscribe')
      .send({ u: params.get('u'), t: params.get('t') });
    expect(res.status).toBe(200);
    expect(res.text).toBe('');
    expect(store.users[0]!.notifications_email_enabled).toBe(false);
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({
      action: 'comms.unsubscribed',
      entityType: 'user',
      entityId: USER_ID,
    });
  });

  it('idempotent: second hit on already-unsubscribed user does not double-audit', async () => {
    store.users[0]!.notifications_email_enabled = false;
    const url = buildUnsubscribeUrl('http://localhost', USER_ID);
    const params = new URL(url).searchParams;
    const res = await request(makeApp())
      .post('/api/v1/comms/unsubscribe')
      .send({ u: params.get('u'), t: params.get('t') });
    expect(res.status).toBe(200);
    expect(auditCalls).toHaveLength(0);
  });

  it('rejects malformed (non-hex) tokens with 200 + no mutation', async () => {
    const res = await request(makeApp())
      .get('/api/v1/comms/unsubscribe')
      .query({ u: USER_ID, t: 'not-hex' });
    expect(res.status).toBe(200);
    expect(store.users[0]!.notifications_email_enabled).toBe(true);
  });
});
