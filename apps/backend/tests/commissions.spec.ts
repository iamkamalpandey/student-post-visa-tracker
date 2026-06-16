// Commissions module integration tests.
//
// Tests the state-machine + summary + idempotency surfaces. Mocks Prisma with
// an in-memory store so the auto-allocation + transition checks run against
// real service code. We mount the real commissionsRouter behind authenticate +
// tenantContext (matching app.ts) and exercise via supertest.
//
// The pre-test "fixture" pre-seeds a CommissionClaim row directly in the
// store (status=PENDING, currency=USD, amount_minor=100000n a.k.a. $1000.00)
// with the institution + program + enrollment relations the fullInclude
// expects. The recalculator/calculator path is covered separately in
// commissions-calculator.spec.ts.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';

// The auto-invoice path issues several DB ops per attempt (count + findFirst)
// and each goes through the tenantContext $transaction wrapper. Default 5s
// vitest timeout is borderline on slower CI hosts; widen to 30s.
const TEST_TIMEOUT_MS = 30_000;

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
type ClaimRow = {
  id: string;
  tenant_id: string;
  enrollment_id: string;
  student_id: string;
  institution_id: string;
  amount_minor: bigint;
  currency: string;
  commission_pct: { toString(): string };
  status: 'PENDING' | 'CLAIMED' | 'INVOICED' | 'PAID' | 'DISPUTED' | 'WAIVED';
  invoice_no: string | null;
  invoiced_on: Date | null;
  claimed_on: Date | null;
  paid_on: Date | null;
  payment_reference: string | null;
  dispute_reason: string | null;
  notes: string | null;
  version: number;
  deleted_at: Date | null;
  created_at: Date;
  updated_by_id: string | null;
};
type IdemRow = {
  id: string;
  tenant_id: string;
  scope: string;
  key: string;
  request_hash: string;
  status: 'PENDING' | 'SUCCESS' | 'FAILED';
  status_code: number | null;
  response: unknown;
  expires_at: Date;
  created_at: Date;
  completed_at: Date | null;
};

const store = {
  claims: [] as ClaimRow[],
  idem: [] as IdemRow[],
};
const auditCalls: Array<{ action: string; entityId: string | null; after?: Record<string, unknown> }> = [];

function resetStore() {
  store.claims.length = 0;
  store.idem.length = 0;
  auditCalls.length = 0;
}

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TENANT_B = '99999999-9999-7999-8999-999999999999';
const ADMIN_ID = '22222222-2222-7222-8222-222222222222';
const COUNSELLOR_ID = '33333333-3333-7333-8333-333333333333';
const INSTITUTION_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const STUDENT_ID = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const ENROLLMENT_ID = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';

function seedPendingClaim(tenant = TENANT_A): ClaimRow {
  const row: ClaimRow = {
    id: randomUUID(),
    tenant_id: tenant,
    enrollment_id: ENROLLMENT_ID,
    student_id: STUDENT_ID,
    institution_id: INSTITUTION_ID,
    amount_minor: 100000n, // $1000.00
    currency: 'USD',
    commission_pct: { toString: () => '10' },
    status: 'PENDING',
    invoice_no: null,
    invoiced_on: null,
    claimed_on: null,
    paid_on: null,
    payment_reference: null,
    dispute_reason: null,
    notes: null,
    version: 1,
    deleted_at: null,
    created_at: new Date(),
    updated_by_id: null,
  };
  store.claims.push(row);
  return row;
}

// Apply a Prisma-shaped data object onto a row: handles plain assignments
// AND the `{ increment: N }` operator used for the version column.
function applyData(r: ClaimRow, data: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && (v as { increment?: number }).increment !== undefined) {
      (r as Record<string, unknown>)[k] =
        ((r as Record<string, unknown>)[k] as number) +
        (v as { increment: number }).increment;
    } else {
      (r as Record<string, unknown>)[k] = v as never;
    }
  }
}

// ---- prisma mock ----
function makePrismaMock() {
  const claimDelegate = {
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      return (
        store.claims.find((r) => {
          if (where['id'] !== undefined && r.id !== where['id']) return false;
          if (where['tenant_id'] !== undefined && r.tenant_id !== where['tenant_id']) return false;
          if (where['deleted_at'] !== undefined && r.deleted_at !== where['deleted_at']) return false;
          if (where['invoice_no'] !== undefined && r.invoice_no !== where['invoice_no']) return false;
          if (
            where['NOT'] &&
            typeof where['NOT'] === 'object' &&
            (where['NOT'] as { id?: string }).id !== undefined &&
            r.id === (where['NOT'] as { id?: string }).id
          )
            return false;
          return true;
        }) ?? null
      );
    }),
    findMany: vi.fn(
      async ({ where, take, cursor, skip }: { where: Record<string, unknown>; take?: number; cursor?: { id: string }; skip?: number }) => {
        let rows = store.claims.filter((r) => {
          if (where['tenant_id'] !== undefined && r.tenant_id !== where['tenant_id']) return false;
          if (where['deleted_at'] !== undefined && r.deleted_at !== where['deleted_at']) return false;
          if (where['status'] !== undefined && r.status !== where['status']) return false;
          return true;
        });
        rows = rows.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
        if (cursor) {
          const idx = rows.findIndex((r) => r.id === cursor.id);
          if (idx >= 0) rows = rows.slice(idx + (skip ?? 0));
        }
        if (typeof take === 'number') rows = rows.slice(0, take);
        return rows;
      },
    ),
    count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      return store.claims.filter((r) => {
        if (where['tenant_id'] !== undefined && r.tenant_id !== where['tenant_id']) return false;
        if (where['deleted_at'] !== undefined && r.deleted_at !== where['deleted_at']) return false;
        if (where['status'] !== undefined && r.status !== where['status']) return false;
        const invFilter = where['invoice_no'] as { startsWith?: string } | string | undefined;
        if (invFilter !== undefined) {
          if (typeof invFilter === 'object' && invFilter.startsWith !== undefined) {
            if (!r.invoice_no || !r.invoice_no.startsWith(invFilter.startsWith)) return false;
          } else if (typeof invFilter === 'string' && r.invoice_no !== invFilter) {
            return false;
          }
        }
        return true;
      }).length;
    }),
    update: vi.fn(
      async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const r = store.claims.find((x) => x.id === where.id);
        if (!r) throw new Error('not found');
        applyData(r, data);
        return r;
      },
    ),
    // SVT-RLS-2026-05 the service uses updateMany + findFirstOrThrow. We need
    // to honour the multi-key where (id + tenant_id + deleted_at) and return
    // a Prisma-shaped {count} result.
    updateMany: vi.fn(
      async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        let count = 0;
        for (const r of store.claims) {
          if (where['id'] !== undefined && r.id !== where['id']) continue;
          if (where['tenant_id'] !== undefined && r.tenant_id !== where['tenant_id']) continue;
          if (where['deleted_at'] !== undefined && r.deleted_at !== where['deleted_at']) continue;
          applyData(r, data);
          count++;
        }
        return { count };
      },
    ),
    findFirstOrThrow: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const r = store.claims.find((x) => {
        if (where['id'] !== undefined && x.id !== where['id']) return false;
        if (where['tenant_id'] !== undefined && x.tenant_id !== where['tenant_id']) return false;
        return true;
      });
      if (!r) throw new Error('not found');
      return r;
    }),
    groupBy: vi.fn(
      async ({ where }: { where: Record<string, unknown> }) => {
        const filtered = store.claims.filter((r) => {
          if (where['tenant_id'] !== undefined && r.tenant_id !== where['tenant_id']) return false;
          if (where['deleted_at'] !== undefined && r.deleted_at !== where['deleted_at']) return false;
          return true;
        });
        const map = new Map<
          string,
          { institution_id: string; currency: string; status: string; sum: bigint; count: number }
        >();
        for (const r of filtered) {
          const key = `${r.institution_id}::${r.currency}::${r.status}`;
          const ex = map.get(key);
          if (ex) {
            ex.sum += r.amount_minor;
            ex.count += 1;
          } else {
            map.set(key, {
              institution_id: r.institution_id,
              currency: r.currency,
              status: r.status,
              sum: r.amount_minor,
              count: 1,
            });
          }
        }
        return Array.from(map.values()).map((g) => ({
          institution_id: g.institution_id,
          currency: g.currency,
          status: g.status,
          _sum: { amount_minor: g.sum },
          _count: { _all: g.count },
        }));
      },
    ),
  };

  const idemDelegate = {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const exists = store.idem.find(
        (r) =>
          r.tenant_id === data['tenant_id'] &&
          r.scope === data['scope'] &&
          r.key === data['key'],
      );
      if (exists) {
        const err = new Error('unique constraint') as Error & { code?: string };
        err.code = 'P2002';
        throw err;
      }
      const row: IdemRow = {
        id: randomUUID(),
        tenant_id: String(data['tenant_id']),
        scope: String(data['scope']),
        key: String(data['key']),
        request_hash: String(data['request_hash']),
        status: 'PENDING',
        status_code: null,
        response: null,
        expires_at: data['expires_at'] as Date,
        created_at: new Date(),
        completed_at: null,
      };
      store.idem.push(row);
      return row;
    }),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      return (
        store.idem.find(
          (r) =>
            r.tenant_id === where['tenant_id'] &&
            r.scope === where['scope'] &&
            r.key === where['key'],
        ) ?? null
      );
    }),
    update: vi.fn(
      async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const r = store.idem.find((x) => x.id === where.id);
        if (!r) throw new Error('not found');
        Object.assign(r, data);
        return r;
      },
    ),
  };

  // The fullInclude on commissionClaim asks Prisma to join student/institution/
  // enrollment. Our mock ignores `include` and returns a synthetic shape that
  // the responses can serialise without crashing. Including these fields keeps
  // the response payload roughly identical to production without requiring real
  // joined rows.
  function withSyntheticIncludes<T extends ClaimRow>(row: T) {
    return {
      ...row,
      student: { id: STUDENT_ID, given_name: 'Asha', family_name: 'Sharma', student_code: 'SPV-2026-000001' },
      institution: { id: row.institution_id, display_name: 'Test University', country_code: 'US' },
      enrollment: {
        id: row.enrollment_id,
        enrollment_no: 'ENR-2026-000001',
        tuition_total_minor: 1000000n,
        tuition_currency: 'USD',
        program: { id: 'p1', name: 'BSc CS', level: 'BACHELORS' },
        program_intake: { id: 'i1', intake_label: 'Fall 2026', intake_year: 2026, intake_month: 9 },
      },
    };
  }

  // Wrap the bare delegates above with include-aware shims so callers that
  // pass `include: fullInclude` see the relations populated.
  const wrappedClaim = {
    findFirst: vi.fn(async (args: Parameters<typeof claimDelegate.findFirst>[0]) => {
      const row = await claimDelegate.findFirst(args);
      return row ? withSyntheticIncludes(row) : null;
    }),
    findFirstOrThrow: vi.fn(async (args: Parameters<typeof claimDelegate.findFirstOrThrow>[0]) => {
      const row = await claimDelegate.findFirstOrThrow(args);
      return withSyntheticIncludes(row);
    }),
    findMany: vi.fn(async (args: Parameters<typeof claimDelegate.findMany>[0]) => {
      const rows = await claimDelegate.findMany(args);
      return rows.map(withSyntheticIncludes);
    }),
    count: claimDelegate.count,
    update: vi.fn(async (args: Parameters<typeof claimDelegate.update>[0]) => {
      const row = await claimDelegate.update(args);
      return withSyntheticIncludes(row);
    }),
    updateMany: claimDelegate.updateMany,
    groupBy: claimDelegate.groupBy,
  };

  const prisma: Record<string, unknown> = {
    commissionClaim: wrappedClaim,
    idempotencyRecord: idemDelegate,
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
      after?: Record<string, unknown>;
    };
    auditCalls.push({
      action: ev.action,
      entityId: ev.entityId ?? ev.entity_id ?? null,
      after: ev.after,
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

const { commissionsRouter } = await import('../src/modules/commissions/routes.js');
const { authenticate } = await import('../src/middlewares/auth.js');
const { tenantContext } = await import('../src/middlewares/tenantContext.js');
const { errorHandler, notFoundHandler } = await import('../src/middlewares/errorHandler.js');
const { signAccessToken } = await import('../src/shared/jwt.js');

function makeApp(): Express {
  const app = express();
  // BigInt.prototype.toJSON shim is installed globally via tests/setup.ts →
  // src/shared/bigint-serializer.ts.
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/v1/commissions', authenticate, tenantContext, commissionsRouter);
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

describe('GET /api/v1/commissions', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/v1/commissions');
    expect(res.status).toBe(401);
  });

  it('lists the seeded PENDING claim with amount_minor=100000 USD', async () => {
    const tok = await tokenFor('ADMIN');
    const seeded = seedPendingClaim();
    const res = await request(app).get('/api/v1/commissions').set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].id).toBe(seeded.id);
    expect(res.body.data[0].status).toBe('PENDING');
    expect(res.body.data[0].amount_minor).toBe('100000');
    expect(res.body.data[0].currency).toBe('USD');
  });
});

describe('state machine', () => {
  it('PENDING -> CLAIMED via /claim', async () => {
    const tok = await tokenFor('ADMIN');
    const seeded = seedPendingClaim();
    const res = await request(app)
      .post(`/api/v1/commissions/${seeded.id}/claim`)
      .set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CLAIMED');
    expect(res.body.claimed_on).toBeTruthy();
    expect(auditCalls.some((c) => c.action === 'commission_claim.claimed')).toBe(true);
  });

  it(
    'CLAIMED -> INVOICED auto-allocates invoice_no matching ^COM-\\d{4}-\\d{2}-\\d{6}$',
    async () => {
      const tok = await tokenFor('ADMIN');
      const seeded = seedPendingClaim();
      seeded.status = 'CLAIMED';
      const res = await request(app)
        .post(`/api/v1/commissions/${seeded.id}/invoice`)
        .set('Authorization', `Bearer ${tok}`)
        .set('Idempotency-Key', randomUUID())
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('INVOICED');
      expect(res.body.invoice_no).toMatch(/^COM-\d{4}-\d{2}-\d{6}$/);
      expect(auditCalls.some((c) => c.action === 'commission_claim.invoiced')).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it('INVOICED -> PAID via /mark-paid', async () => {
    const tok = await tokenFor('ADMIN');
    const seeded = seedPendingClaim();
    seeded.status = 'INVOICED';
    seeded.invoice_no = 'COM-2026-05-000001';
    const res = await request(app)
      .post(`/api/v1/commissions/${seeded.id}/mark-paid`)
      .set('Authorization', `Bearer ${tok}`)
      .set('Idempotency-Key', randomUUID())
      .send({ paid_on: '2026-05-14', payment_reference: 'WIRE-12345' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('PAID');
    expect(res.body.payment_reference).toBe('WIRE-12345');
    expect(auditCalls.some((c) => c.action === 'commission_claim.paid')).toBe(true);
  });

  it('records a short-payment variance via received_minor on mark-paid', async () => {
    const tok = await tokenFor('ADMIN');
    const seeded = seedPendingClaim();
    seeded.status = 'INVOICED';
    const res = await request(app)
      .post(`/api/v1/commissions/${seeded.id}/mark-paid`)
      .set('Authorization', `Bearer ${tok}`)
      .set('Idempotency-Key', randomUUID())
      .send({ paid_on: '2026-05-14', received_minor: '90000' }); // claimed 100000, $100 short
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('PAID');
    const paid = auditCalls.find((c) => c.action === 'commission_claim.paid') as
      | { after?: { received_minor?: unknown; variance_minor?: unknown } }
      | undefined;
    expect(String(paid?.after?.received_minor)).toBe('90000');
    expect(String(paid?.after?.variance_minor)).toBe('10000');
  });

  it('defaults received_minor to the full claimed amount when omitted', async () => {
    const tok = await tokenFor('ADMIN');
    const seeded = seedPendingClaim();
    seeded.status = 'INVOICED';
    await request(app)
      .post(`/api/v1/commissions/${seeded.id}/mark-paid`)
      .set('Authorization', `Bearer ${tok}`)
      .set('Idempotency-Key', randomUUID())
      .send({ paid_on: '2026-05-14' });
    const paid = auditCalls.find((c) => c.action === 'commission_claim.paid') as
      | { after?: { received_minor?: unknown; variance_minor?: unknown } }
      | undefined;
    expect(String(paid?.after?.received_minor)).toBe('100000');
    expect(String(paid?.after?.variance_minor)).toBe('0');
  });

  it('cannot dispute a PAID claim (409 Conflict — terminal)', async () => {
    const tok = await tokenFor('ADMIN');
    const seeded = seedPendingClaim();
    seeded.status = 'PAID';
    const res = await request(app)
      .post(`/api/v1/commissions/${seeded.id}/dispute`)
      .set('Authorization', `Bearer ${tok}`)
      .send({ dispute_reason: 'Wrong amount' });
    expect(res.status).toBe(409);
    expect(res.body.title).toBe('Conflict');
  });

  it('INVOICED -> DISPUTED via /dispute', async () => {
    const tok = await tokenFor('ADMIN');
    const seeded = seedPendingClaim();
    seeded.status = 'INVOICED';
    const res = await request(app)
      .post(`/api/v1/commissions/${seeded.id}/dispute`)
      .set('Authorization', `Bearer ${tok}`)
      .send({ dispute_reason: 'Counterparty disputes the calculation' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('DISPUTED');
  });

  it('any -> WAIVED via /waive', async () => {
    const tok = await tokenFor('ADMIN');
    const seeded = seedPendingClaim();
    seeded.status = 'CLAIMED';
    const res = await request(app)
      .post(`/api/v1/commissions/${seeded.id}/waive`)
      .set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('WAIVED');
  });
});

describe('role gating', () => {
  it('non-admin counsellor cannot POST /claim (403)', async () => {
    const tok = await tokenFor('COUNSELLOR');
    const seeded = seedPendingClaim();
    const res = await request(app)
      .post(`/api/v1/commissions/${seeded.id}/claim`)
      .set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(403);
  });

  it('viewer cannot POST anything (403)', async () => {
    const tok = await tokenFor('VIEWER');
    const seeded = seedPendingClaim();
    const res = await request(app)
      .post(`/api/v1/commissions/${seeded.id}/claim`)
      .set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(403);
  });
});

describe('validation', () => {
  it('mark-paid without paid_on returns 422 RFC 7807', async () => {
    const tok = await tokenFor('ADMIN');
    const seeded = seedPendingClaim();
    seeded.status = 'INVOICED';
    const res = await request(app)
      .post(`/api/v1/commissions/${seeded.id}/mark-paid`)
      .set('Authorization', `Bearer ${tok}`)
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(res.status).toBe(422);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  });
});

describe('idempotency', () => {
  it(
    'replays the same response on a duplicate Idempotency-Key without side effects',
    async () => {
      const tok = await tokenFor('ADMIN');
      const seeded = seedPendingClaim();
      seeded.status = 'CLAIMED';
      const idemKey = randomUUID();

      const first = await request(app)
        .post(`/api/v1/commissions/${seeded.id}/invoice`)
        .set('Authorization', `Bearer ${tok}`)
        .set('Idempotency-Key', idemKey)
        .send({});
      expect(first.status).toBe(200);
      expect(first.body.status).toBe('INVOICED');
      const firstInvoiceNo = first.body.invoice_no as string;

      // Force the row back to CLAIMED so a real (non-idempotent) re-run would
      // re-allocate a different invoice number. The replay should bypass that
      // and return the cached body.
      const stateBefore = store.claims.find((c) => c.id === seeded.id)!.status;

      const second = await request(app)
        .post(`/api/v1/commissions/${seeded.id}/invoice`)
        .set('Authorization', `Bearer ${tok}`)
        .set('Idempotency-Key', idemKey)
        .send({});
      expect(second.status).toBe(200);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.body.invoice_no).toBe(firstInvoiceNo);

      // Service did not run a second time — state didn't change beyond what the
      // first call produced.
      const stateAfter = store.claims.find((c) => c.id === seeded.id)!.status;
      expect(stateAfter).toBe(stateBefore);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('summary', () => {
  it('GET /commissions/summary returns per-institution-currency rollups', async () => {
    const tok = await tokenFor('ADMIN');
    const a = seedPendingClaim();
    a.status = 'CLAIMED';
    const b = seedPendingClaim();
    b.status = 'INVOICED';
    const res = await request(app)
      .get('/api/v1/commissions/summary')
      .set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBe(1);
    const row = res.body.data[0];
    expect(row.institution_id).toBe(INSTITUTION_ID);
    expect(row.currency).toBe('USD');
    expect(row.claimed_total_minor).toBe('100000');
    expect(row.invoiced_total_minor).toBe('100000');
    // outstanding = CLAIMED + INVOICED
    expect(row.outstanding_total_minor).toBe('200000');
  });
});

describe('tenant isolation', () => {
  it('tenant B cannot see tenant A commission claim', async () => {
    const aTok = await tokenFor('ADMIN', TENANT_A);
    const bTok = await tokenFor('ADMIN', TENANT_B);
    const seeded = seedPendingClaim(TENANT_A);
    void aTok;
    const res = await request(app)
      .get(`/api/v1/commissions/${seeded.id}`)
      .set('Authorization', `Bearer ${bTok}`);
    expect(res.status).toBe(404);
  });
});

describe('resolve-dispute', () => {
  it(
    'POST /resolve-dispute on a DISPUTED claim flips status to INVOICED, clears dispute_reason, bumps version',
    async () => {
      const tok = await tokenFor('ADMIN');
      const seeded = seedPendingClaim();
      seeded.status = 'DISPUTED';
      seeded.dispute_reason = 'Counterparty contests the calculation';
      const versionBefore = seeded.version;

      const res = await request(app)
        .post(`/api/v1/commissions/${seeded.id}/resolve-dispute`)
        .set('Authorization', `Bearer ${tok}`)
        .set('Idempotency-Key', randomUUID())
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('INVOICED');
      expect(res.body.dispute_reason).toBeNull();
      expect(res.body.version).toBe(versionBefore + 1);
      expect(
        auditCalls.some((c) => c.action === 'commission_claim.dispute_resolved'),
      ).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'POST /resolve-dispute on a non-DISPUTED claim returns 409 Conflict',
    async () => {
      const tok = await tokenFor('ADMIN');
      for (const status of ['PENDING', 'CLAIMED', 'PAID'] as const) {
        const seeded = seedPendingClaim();
        seeded.status = status;
        if (status === 'PAID') seeded.invoice_no = 'COM-2026-05-000099';
        const res = await request(app)
          .post(`/api/v1/commissions/${seeded.id}/resolve-dispute`)
          .set('Authorization', `Bearer ${tok}`)
          .set('Idempotency-Key', randomUUID())
          .send({});
        expect(res.status).toBe(409);
        expect(res.body.title).toBe('Conflict');
        expect(String(res.body.detail)).toMatch(/resolve only works on DISPUTED/);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'POST /resolve-dispute is idempotent: same Idempotency-Key returns the cached response',
    async () => {
      const tok = await tokenFor('ADMIN');
      const seeded = seedPendingClaim();
      seeded.status = 'DISPUTED';
      seeded.dispute_reason = 'Mismatch on commission_pct';
      const idemKey = randomUUID();

      const first = await request(app)
        .post(`/api/v1/commissions/${seeded.id}/resolve-dispute`)
        .set('Authorization', `Bearer ${tok}`)
        .set('Idempotency-Key', idemKey)
        .send({ resolution_notes: 'Counterparty agreed after review.' });
      expect(first.status).toBe(200);
      expect(first.body.status).toBe('INVOICED');
      const versionAfterFirst = first.body.version as number;

      const second = await request(app)
        .post(`/api/v1/commissions/${seeded.id}/resolve-dispute`)
        .set('Authorization', `Bearer ${tok}`)
        .set('Idempotency-Key', idemKey)
        .send({ resolution_notes: 'Counterparty agreed after review.' });
      expect(second.status).toBe(200);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.body.version).toBe(versionAfterFirst);
      // Service did not run a second time — no extra dispute_resolved audit row.
      const resolvedAudits = auditCalls.filter(
        (c) => c.entityId === seeded.id && c.action === 'commission_claim.dispute_resolved',
      );
      expect(resolvedAudits.length).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('audit row sequence', () => {
  it(
    'emits commission_claim.{claimed, invoiced, paid} in order',
    async () => {
      const tok = await tokenFor('ADMIN');
      const seeded = seedPendingClaim();

      await request(app)
        .post(`/api/v1/commissions/${seeded.id}/claim`)
        .set('Authorization', `Bearer ${tok}`);
      await request(app)
        .post(`/api/v1/commissions/${seeded.id}/invoice`)
        .set('Authorization', `Bearer ${tok}`)
        .set('Idempotency-Key', randomUUID())
        .send({});
      await request(app)
        .post(`/api/v1/commissions/${seeded.id}/mark-paid`)
        .set('Authorization', `Bearer ${tok}`)
        .set('Idempotency-Key', randomUUID())
        .send({ paid_on: '2026-05-14' });

      const actions = auditCalls.filter((c) => c.entityId === seeded.id).map((c) => c.action);
      expect(actions).toEqual([
        'commission_claim.claimed',
        'commission_claim.invoiced',
        'commission_claim.paid',
      ]);
    },
    TEST_TIMEOUT_MS,
  );
});
