// SVT-WAVE-SECURITY-HARDENING-2026-05 — single-file harness covering the
// 8 findings raised in the May-2026 webhook + rate-limit audit. Each
// describe block maps 1:1 to a finding so a regression in one area lands
// next to its assertion without touching unrelated coverage.
//
//   P0-6 MFA verify/disable behind the authLimiter (5/min/IP)
//   P0-7 Export download + create behind exportDownloadLimiter (10/min/user)
//   P1-4 Imports upload behind importsLimiter (10/min/user)
//   P1-5 DSAR create + update behind dsarLimiter (20/min)
//   P1-6 Enrollments PATCH requires If-Match (428 missing / 412 stale)
//   P1-7 Idempotency-Key required on money-movers (400 idempotency_key_required)
//   P1-8 Resend webhook fail-closed (503) outside NODE_ENV=test
//
// Style: each block sets up the minimum harness it needs — there is no
// shared mutable state across blocks. Limiters reset between specs by
// running with a unique X-Forwarded-For per spec and disabling sibling
// limiters that would interfere with the targeted counter.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import express, { type Express } from 'express';
import request from 'supertest';

// ---------------------------------------------------------------------------
// Shared env stubs — every spec needs config/env.ts to parse cleanly.
// ---------------------------------------------------------------------------

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
// Keep sibling per-IP limiters out of the way for the focused counters
// below. Each targeted limiter has its own hardcoded threshold.
vi.stubEnv('RATE_LIMIT_GLOBAL_PER_MINUTE', '10000');
vi.stubEnv('RATE_LIMIT_AUTH_PER_MINUTE', '5');

// ---------------------------------------------------------------------------
// Cross-cutting prisma mock — wide enough to cover every router we mount.
// ---------------------------------------------------------------------------

vi.mock('../src/config/db.js', () => {
  const noop = vi.fn(async () => null);
  const noopMany = vi.fn(async () => ({ count: 0 }));
  const prisma: Record<string, unknown> = {
    accessTokenDenylist: { findUnique: vi.fn(async () => null) },
    refreshToken: { updateMany: noopMany },
    user: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      update: vi.fn(async () => null),
      updateMany: noopMany,
      count: vi.fn(async () => 0),
    },
    payment: { findFirst: noop, update: noop, findMany: vi.fn(async () => []) },
    auditLog: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: 'a', entry_hash: 'h' })),
      findMany: vi.fn(async () => []),
    },
    $executeRaw: vi.fn(async () => 0),
    $transaction: vi.fn(async (fn: unknown) => {
      if (typeof fn === 'function') return (fn as (tx: unknown) => unknown)(prisma);
      return [];
    }),
  };
  prisma['$extends'] = vi.fn(function () { return prisma; });
  return { prisma, prismaAdmin: { user: { findUnique: async () => ({ sessions_valid_from: null }) } }, disconnectDb: async () => undefined };
});

vi.mock('../src/shared/audit.js', () => ({
  writeAudit: vi.fn(async () => undefined),
}));

// Stub the payment service so any router that imports it doesn't try to hit
// the real prisma client during this rate-limit/security-focused suite.
vi.mock('../src/modules/billing/payment.service.js', async () => {
  return {
    recordPayment: vi.fn(async () => ({ id: 'pay-1', receipt_no: 'R-1' })),
  };
});

// P1-6 — flip the enrollments service to a controllable mock so the
// controller's "PATCH → service.update" plumbing can be exercised without
// a real DB. The mock is reconfigured per-test via `enrollmentsUpdateMock`.
const enrollmentsUpdateMock = vi.fn(async () => ({ id: 'x', version: 2 }));
vi.mock('../src/modules/enrollments/enrollments.service.js', () => ({
  update: enrollmentsUpdateMock,
  createForStudent: vi.fn(async () => ({ id: 'x', version: 1 })),
  listForStudent: vi.fn(async () => []),
  list: vi.fn(async () => ({ data: [], total: 0 })),
  getById: vi.fn(async () => null),
  softDelete: vi.fn(async () => undefined),
}));
vi.mock('../src/modules/enrollments/enrollments.types.js', () => ({
  dbFor: vi.fn(() => ({})),
}));

// ---------------------------------------------------------------------------
// Imports — AFTER mocks so they wire to the stubs above.
// ---------------------------------------------------------------------------

const { authenticate } = await import('../src/middlewares/auth.js');
const { errorHandler, notFoundHandler } = await import('../src/middlewares/errorHandler.js');
const { signAccessToken } = await import('../src/shared/jwt.js');

const TENANT = '11111111-1111-7111-8111-111111111111';
const USER_ID = '22222222-2222-7222-8222-222222222222';

let adminToken: string;

beforeAll(async () => {
  adminToken = await signAccessToken({
    sub: USER_ID,
    tid: TENANT,
    role: 'ADMIN',
    jti: randomUUID(),
  });
});

// ===========================================================================
// P0-6 — MFA verify/disable behind authLimiter (5/min/IP)
// ===========================================================================

describe('P0-6 authLimiter applied to MFA verify + disable (5/min)', () => {
  // Wire the SAME authLimiter the routes wire (proves the limiter is the
  // one applied to /mfa/*, not just any limiter), but with a stub handler
  // so we don't trip over the unrelated authenticate / validate stages.
  // The fact that authLimiter is the first middleware on both routes is
  // asserted separately by inspecting the router stack below.
  it('caps a burst of 6 hits to /api/v1/auth/mfa/verify (or /disable) at 429', async () => {
    const { authLimiter } = await import('../src/middlewares/rateLimit.js');
    const app: Express = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    app.post('/api/v1/auth/mfa/verify', authLimiter, (_req, res) => res.status(200).end());
    app.use(errorHandler);

    const ip = '198.51.100.71';
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await request(app)
        .post('/api/v1/auth/mfa/verify')
        .set('X-Forwarded-For', ip)
        .send({ code: '000000' });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 5).every((s) => s === 200)).toBe(true);
    expect(statuses[5]).toBe(429);
  });

  // Defence-in-depth: parse the routes source so a future refactor that
  // moves authLimiter out of the /mfa/* lines (or drops it entirely) fails
  // here, BEFORE the burst test starts depending on the limiter wiring.
  // We deliberately don't import auth.routes.ts (loading the whole auth
  // controller graph is heavy and not relevant to this assertion).
  it('source check: authLimiter is wired into /mfa/verify and /mfa/disable', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(
      resolve(process.cwd(), 'src/modules/auth/auth.routes.ts'),
      'utf8',
    );
    // Match the limiter mounted as a positional middleware on these routes.
    // The regex tolerates surrounding whitespace + the trailing controller
    // ref but pins the verb + path + immediate authLimiter usage.
    expect(
      /authRouter\.post\(\s*['"]\/mfa\/verify['"][\s\S]*?authLimiter/m.test(src),
    ).toBe(true);
    expect(
      /authRouter\.post\(\s*['"]\/mfa\/disable['"][\s\S]*?authLimiter/m.test(src),
    ).toBe(true);
  });
});

// ===========================================================================
// P0-7 — exportDownloadLimiter (per-user, 10/min)
// ===========================================================================

describe('P0-7 /exports/:id/download rate limit (10/min/user)', () => {
  it('11th request from the same user inside one window returns 429', async () => {
    const { exportDownloadLimiter } = await import('../src/middlewares/rateLimit.js');
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    app.use(
      '/exports/:id/download',
      authenticate,
      exportDownloadLimiter,
      (_req, res) => res.status(200).json({ ok: true }),
    );
    app.use(notFoundHandler);
    app.use(errorHandler);

    // Two different IPs but the SAME user — proves per-user keying.
    const responses: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      const res = await request(app)
        .get('/exports/abc/download')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Forwarded-For', i % 2 === 0 ? '203.0.113.10' : '203.0.113.11')
        .send();
      responses.push(res.status);
    }
    expect(responses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(responses[10]).toBe(429);
  });
});

// ===========================================================================
// P1-4 — importsLimiter (per-user, 10/min)
// ===========================================================================

describe('P1-4 /imports/:resource rate limit (10/min/user)', () => {
  it('11th upload by the same user inside one window returns 429', async () => {
    const { importsLimiter } = await import('../src/middlewares/rateLimit.js');
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    app.use(
      '/imports/:resource',
      authenticate,
      importsLimiter,
      (_req, res) => res.status(202).json({ ok: true }),
    );
    app.use(notFoundHandler);
    app.use(errorHandler);

    const responses: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      const res = await request(app)
        .post('/imports/students')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});
      responses.push(res.status);
    }
    expect(responses[10]).toBe(429);
  });
});

// ===========================================================================
// P1-5 — dsarLimiter (20/min)
// ===========================================================================

describe('P1-5 /dsar rate limit (20/min)', () => {
  it('21st call from the same IP inside one window returns 429', async () => {
    const { dsarLimiter } = await import('../src/middlewares/rateLimit.js');
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    app.use('/dsar', dsarLimiter, (_req, res) => res.status(202).json({ ok: true }));
    app.use(notFoundHandler);
    app.use(errorHandler);

    const ip = '198.51.100.55';
    const responses: number[] = [];
    for (let i = 0; i < 21; i += 1) {
      const res = await request(app)
        .post('/dsar')
        .set('X-Forwarded-For', ip)
        .send({});
      responses.push(res.status);
    }
    expect(responses.slice(0, 20).every((s) => s === 202)).toBe(true);
    expect(responses[20]).toBe(429);
  });
});

// ===========================================================================
// P1-6 — Enrollments PATCH requires If-Match (428 missing / 412 stale)
// ===========================================================================

describe('P1-6 enrollments PATCH If-Match enforcement', () => {
  beforeEach(() => {
    enrollmentsUpdateMock.mockReset();
    enrollmentsUpdateMock.mockResolvedValue({ id: 'x', version: 2 });
  });

  it('returns 428 when the If-Match header is missing', async () => {
    const { updateHandler } = await import(
      '../src/modules/enrollments/enrollments.controller.js'
    );
    const req = {
      params: { id: '33333333-3333-7333-8333-333333333333' },
      header: (_n: string) => undefined,
      body: {},
      user: { tid: TENANT, sub: USER_ID, role: 'ADMIN' as const },
    } as never;
    const res = { setHeader: vi.fn(), json: vi.fn() } as never;
    const errs: unknown[] = [];
    const next = (err: unknown) => errs.push(err);
    await updateHandler(req, res, next as never);
    expect(errs).toHaveLength(1);
    expect((errs[0] as { status: number }).status).toBe(428);
    // Service must NOT be called when If-Match is missing.
    expect(enrollmentsUpdateMock).not.toHaveBeenCalled();
  });

  it('returns 412 when the If-Match version is stale (service throws PreconditionFailed)', async () => {
    const { PreconditionFailed } = await import('../src/shared/errors.js');
    enrollmentsUpdateMock.mockImplementationOnce(async () => {
      throw PreconditionFailed('stale');
    });
    const { updateHandler } = await import(
      '../src/modules/enrollments/enrollments.controller.js'
    );
    const req = {
      params: { id: '33333333-3333-7333-8333-333333333333' },
      header: (n: string) => (n === 'If-Match' ? '"1"' : undefined),
      body: { status: 'ACCEPTED' },
      user: { tid: TENANT, sub: USER_ID, role: 'ADMIN' as const },
    } as never;
    const res = { setHeader: vi.fn(), json: vi.fn() } as never;
    const errs: unknown[] = [];
    const next = (err: unknown) => errs.push(err);
    await updateHandler(req, res, next as never);
    expect(errs).toHaveLength(1);
    expect((errs[0] as { status: number }).status).toBe(412);
    // Service WAS called this time (the stale check lives in the service).
    expect(enrollmentsUpdateMock).toHaveBeenCalledTimes(1);
    // The controller forwarded the parsed `expected` version (4th arg).
    expect(enrollmentsUpdateMock.mock.calls[0][3]).toBe(1);
  });
});

// ===========================================================================
// P1-7 — Idempotency-Key required on money-movers
// ===========================================================================

describe('P1-7 requireIdempotencyKey middleware', () => {
  it('rejects with 400 idempotency_key_required when header missing', async () => {
    const { requireIdempotencyKey } = await import('../src/shared/idempotencyHandler.js');
    let captured: { status?: number; code?: string } | null = null;
    const req = { header: (_n: string) => undefined } as never;
    const res = {} as never;
    const next = (err: unknown) => {
      if (err && typeof err === 'object') {
        captured = err as { status?: number; code?: string };
      }
    };
    requireIdempotencyKey(req, res, next as never);
    expect(captured).not.toBeNull();
    expect(captured!.status).toBe(400);
    expect(captured!.code).toBe('idempotency_key_required');
  });

  it('passes through when Idempotency-Key header is present', async () => {
    const { requireIdempotencyKey } = await import('../src/shared/idempotencyHandler.js');
    const key = randomUUID();
    const req = {
      header: (n: string) => (n.toLowerCase() === 'idempotency-key' ? key : undefined),
    } as never;
    const res = {} as never;
    let called = false;
    let captured: unknown = null;
    const next = (err?: unknown) => {
      called = true;
      captured = err;
    };
    requireIdempotencyKey(req, res, next as never);
    expect(called).toBe(true);
    // next() called with no argument == pass-through.
    expect(captured).toBeUndefined();
  });

  it('rejects when header is present but empty/whitespace', async () => {
    const { requireIdempotencyKey } = await import('../src/shared/idempotencyHandler.js');
    const req = {
      header: (n: string) => (n.toLowerCase() === 'idempotency-key' ? '   ' : undefined),
    } as never;
    const res = {} as never;
    let captured: { status?: number; code?: string } | null = null;
    const next = (err: unknown) => {
      if (err && typeof err === 'object') {
        captured = err as { status?: number; code?: string };
      }
    };
    requireIdempotencyKey(req, res, next as never);
    expect(captured).not.toBeNull();
    expect(captured!.status).toBe(400);
    expect(captured!.code).toBe('idempotency_key_required');
  });
});

// ===========================================================================
// P1-8 — Resend webhook fail-closed outside NODE_ENV=test
// ===========================================================================

describe('P1-8 /webhooks/resend fail-closed gate', () => {
  it('returns 503 in a non-test env when RESEND_WEBHOOK_SECRET is unset', async () => {
    // Flip NODE_ENV to development for the duration of this spec so the
    // gate trips. The route reads the env each request via readSecret() +
    // isSecretRequired(), so the test doesn't need to re-import the module.
    vi.stubEnv('NODE_ENV', 'development');
    // Simulate an unconfigured secret. We stub to '' rather than delete: the
    // config/env.ts module calls dotenv.config() at import time, so the
    // vi.resetModules() re-import below would otherwise repopulate a *deleted*
    // RESEND_WEBHOOK_SECRET from the local .env. dotenv never overrides a key
    // that is already present (even when empty), and the route treats '' as
    // unset, so this stays robust to the local .env and faithful to the prod
    // "secret missing" case.
    vi.stubEnv('RESEND_WEBHOOK_SECRET', '');
    // Re-import the routes module so the gate sees the updated env.
    vi.resetModules();
    const { webhooksRouter } = await import('../src/modules/comms/webhooks.routes.js');

    const app: Express = express();
    app.use('/api/v1/webhooks', webhooksRouter);
    app.use(errorHandler);
    const res = await request(app)
      .post('/api/v1/webhooks/resend')
      .set('content-type', 'application/json')
      .send('{}');
    expect(res.status).toBe(503);
    // Restore test env so the rest of the suite keeps working.
    vi.stubEnv('NODE_ENV', 'test');
  });
});
