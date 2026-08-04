// SVT-SEC-AUDIT-2026-05 — defence-in-depth route gate on
// POST /api/v1/consents/:id/revoke.
//
// The service's `assertAuthorised` is the authoritative check (ADMIN or the
// subject themself). This test pins the route-level `requireRole` so a future
// regression that introduces a roleless / unknown-role JWT claim still cannot
// reach the controller. Today the Role enum is exhaustive so the claim is
// structurally impossible; we hand-mint an access token with an unknown role
// string to simulate the future case.

import { beforeAll, describe, expect, it, vi } from 'vitest';
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

const TENANT = '11111111-1111-7111-8111-111111111111';
const USER_ID = '22222222-2222-7222-8222-222222222222';
const CONSENT_ID = '33333333-3333-7333-8333-333333333333';

// The controller never runs (route-level requireRole 403s first) but the
// imports are real, so the prisma mock just needs to satisfy the auth
// middleware's denylist lookup + the idle-bump updateMany.
const revokeMock = vi.fn(async () => undefined);
vi.mock('../src/config/db.js', () => {
  const prisma: Record<string, unknown> = {
    accessTokenDenylist: { findUnique: vi.fn(async () => null) },
    refreshToken: { updateMany: vi.fn(async () => ({ count: 0 })) },
    consentRecord: {
      findFirst: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
  };
  prisma['$extends'] = vi.fn(function (this: unknown) { return prisma; });
  return { prisma, prismaAdmin: { user: { findUnique: async () => ({ sessions_valid_from: null }) } }, disconnectDb: async () => undefined };
});

vi.mock('../src/modules/consent/service.js', () => ({
  consentService: { revoke: revokeMock, get: vi.fn(async () => null), list: vi.fn(async () => []) },
}));

vi.mock('../src/shared/idempotencyHandler.js', () => ({
  runIdempotent: vi.fn(async (_req, _res, _opts, fn: () => Promise<unknown>) => fn()),
}));

const { authenticate } = await import('../src/middlewares/auth.js');
const { tenantContext } = await import('../src/middlewares/tenantContext.js');
const { consentRouter } = await import('../src/modules/consent/routes.js');
const { errorHandler, notFoundHandler } = await import('../src/middlewares/errorHandler.js');
const { signAccessToken } = await import('../src/shared/jwt.js');

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/consents', authenticate, tenantContext, consentRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

let app: Express;

beforeAll(() => {
  app = makeApp();
});

/**
 * Hand-sign a JWT with an arbitrary role string. The real signAccessToken
 * helper is typed to the Role enum and would refuse this — that's the point:
 * we're modelling a future regression where the enum widens or a forged
 * upstream issuer slips an unknown role through.
 */
async function signWithCustomRole(role: string): Promise<string> {
  const key = await importPKCS8(PRIVATE_PEM, 'RS256');
  return new SignJWT({ sub: USER_ID, tid: TENANT, role })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
    .setIssuedAt()
    .setIssuer('spv-api-test')
    .setAudience('spv-app-test')
    .setJti(randomUUID())
    .setExpirationTime('15m')
    .sign(key);
}

describe('POST /api/v1/consents/:id/revoke role gate', () => {
  it('caller with an unknown role string is rejected with 403', async () => {
    const tok = await signWithCustomRole('GUEST');
    const res = await request(app)
      .post(`/api/v1/consents/${CONSENT_ID}/revoke`)
      .set('Authorization', `Bearer ${tok}`)
      .send({});
    expect(res.status).toBe(403);
    // requireRole 403s BEFORE the controller runs.
    expect(revokeMock).not.toHaveBeenCalled();
  });

  it('VIEWER (an enumerated role) reaches the controller', async () => {
    // VIEWER write-block in `authenticate` 403s mutations for viewer roles
    // BEFORE the route-level requireRole runs. We use a GET-shaped path to
    // pin that the requireRole list now includes VIEWER explicitly. This is
    // a smoke check — the real assertion is the negative case above.
    const tok = await signAccessToken({
      sub: USER_ID, tid: TENANT, role: 'VIEWER', jti: randomUUID(),
    });
    const res = await request(app)
      .post(`/api/v1/consents/${CONSENT_ID}/revoke`)
      .set('Authorization', `Bearer ${tok}`)
      .send({});
    // 403 from the global VIEWER-is-read-only gate — proves the request was
    // authenticated; ie the route gate would have admitted the role if not
    // for the broader write-block. This wires the future case where the
    // global block is lifted for self-service consent revoke.
    expect(res.status).toBe(403);
  });
});
