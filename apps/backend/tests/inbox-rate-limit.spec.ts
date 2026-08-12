// SVT-SEC-AUDIT-2026-05 — per-IP inbox-mutation limiter (20/min).
//
// /inbox/* is deliberately NOT role-gated — every authenticated user has an
// inbox. To keep `POST /messages/read-all` from being a free spam channel
// we mount `inboxMutationLimiter` per-route. This test fires 21 calls in
// quick succession and asserts the 21st returns 429.

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
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
// Make sure no sibling limiter (global / tenant) interferes with the 21-call
// burst — only the per-IP inboxMutationLimiter (hardcoded 20/min) matters.
vi.stubEnv('RATE_LIMIT_GLOBAL_PER_MINUTE', '10000');
vi.stubEnv('RATE_LIMIT_AUTH_PER_MINUTE', '10000');

const TENANT = '11111111-1111-7111-8111-111111111111';
const USER_ID = '22222222-2222-7222-8222-222222222222';

// updateMany / count stubs so the controller succeeds on every call until
// the limiter kicks in.
vi.mock('../src/config/db.js', () => {
  const prisma: Record<string, unknown> = {
    commsMessage: {
      updateMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
    accessTokenDenylist: { findUnique: vi.fn(async () => null) },
    refreshToken: { updateMany: vi.fn(async () => ({ count: 0 })) },
  };
  // tenantContext middleware calls prisma.$extends — return the same shape so
  // the scoped client is a no-op proxy back to the same mocks.
  prisma['$extends'] = vi.fn(function (this: unknown) { return prisma; });
  return { prisma, prismaAdmin: {
    // SVT-SEC-2026-08 — authenticate() reads the JTI denylist via the
    // BYPASS-RLS client (it runs before tenantContext sets the GUC) and fails
    // CLOSED when the lookup throws. null = "this token was never revoked".
    accessTokenDenylist: { findUnique: async () => null }, user: { findUnique: async () => ({ sessions_valid_from: null }) } }, disconnectDb: async () => undefined };
});

vi.mock('../src/shared/audit.js', () => ({
  writeAudit: vi.fn(async () => undefined),
}));

const { authenticate } = await import('../src/middlewares/auth.js');
const { tenantContext } = await import('../src/middlewares/tenantContext.js');
const { inboxRouter } = await import('../src/modules/comms/routes.js');
const { errorHandler, notFoundHandler } = await import('../src/middlewares/errorHandler.js');
const { signAccessToken } = await import('../src/shared/jwt.js');

function makeApp(): Express {
  const app = express();
  // Trust ONE forwarded proxy hop so we can pin a deterministic client IP per
  // test via X-Forwarded-For. We use `1` (not `true`) to avoid the
  // express-rate-limit permissive-trust-proxy validation warning.
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/api/v1/inbox', authenticate, tenantContext, inboxRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

let app: Express;
let token: string;

beforeAll(async () => {
  app = makeApp();
  token = await signAccessToken({
    sub: USER_ID, tid: TENANT, role: 'COUNSELLOR', jti: randomUUID(),
  });
});

describe('POST /inbox/messages/read-all rate limit (20/min)', () => {
  it('21st call from the same IP inside one window returns 429', async () => {
    // Use a fixed forwarded IP so the limiter counter is deterministic and
    // independent of supertest's default 127.0.0.1 (which may have been
    // touched by sibling specs).
    const ip = '198.51.100.42';
    const responses: number[] = [];
    for (let i = 0; i < 21; i += 1) {
      const res = await request(app)
        .post('/api/v1/inbox/messages/read-all')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Forwarded-For', ip)
        .send({});
      responses.push(res.status);
    }
    // First 20 must succeed (200), the 21st must be throttled.
    expect(responses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(responses[20]).toBe(429);
  });
});
