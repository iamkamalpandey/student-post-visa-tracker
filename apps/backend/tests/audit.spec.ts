import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

beforeAll(() => {
  process.env.NODE_ENV = 'test';
});

// ---------------------------------------------------------------------------
// Mock prisma. The real db.ts will fail to construct a PrismaClient without a
// DATABASE_URL or with no Postgres running, so we replace the whole module.
//
// vi.mock factories are hoisted ABOVE all `import` statements *and* above any
// top-level `const`/`let`. To share state with the test body we wrap the
// mutable bookkeeping objects in `vi.hoisted` so they get hoisted alongside
// the mocks themselves — the factories then close over the *same* objects
// that the test body sees.
// ---------------------------------------------------------------------------
const { created, getLastEntryHash, setLastEntryHash, prismaMock, loggedErrors } = vi.hoisted(() => {
  const created: Array<Record<string, unknown>> = [];
  let lastEntryHash: string | null = null;
  const loggedErrors: Array<{ obj: unknown; msg: string }> = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prismaMock: any = {
    auditLog: {
      // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
      findFirst: undefined as unknown,
      create: undefined as unknown,
    },
    $transaction: undefined as unknown,
    // SVT-SEC-2026-08 (T0-7) — tenant-scoped audit writes now run inside
    // withTenantTx, which issues `SELECT set_config('app.tenant_id', …)` before
    // the insert. Without the GUC the audit_logs policy rejects every
    // tenant-scoped row under the production role.
    $executeRaw: undefined as unknown,
  };

  return {
    created,
    getLastEntryHash: () => lastEntryHash,
    setLastEntryHash: (v: string | null) => {
      lastEntryHash = v;
    },
    prismaMock,
    loggedErrors,
  };
});

// vi.fn must be created lazily after the hoisted block returns; assign now.
prismaMock.auditLog.findFirst = vi.fn(async () => {
  const h = getLastEntryHash();
  return h ? { entry_hash: h } : null;
});
prismaMock.auditLog.create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
  created.push(data);
  setLastEntryHash(String(data['entry_hash']));
  return data;
});
prismaMock.$transaction = vi.fn(async (fn: (tx: typeof prismaMock) => Promise<unknown>) => fn(prismaMock));
prismaMock.$executeRaw = vi.fn(async () => 1);

vi.mock('../src/config/db.js', () => ({
  prisma: prismaMock,
  disconnectDb: async () => {},
}));

// ---------------------------------------------------------------------------
// Capture pino output. We replace the logger module so we can inspect what
// writeAudit logs when encryption fails.
// ---------------------------------------------------------------------------
vi.mock('../src/config/logger.js', () => ({
  logger: {
    error: (obj: unknown, msg: string) => {
      loggedErrors.push({ obj, msg });
    },
    warn: () => {},
    info: () => {},
    debug: () => {},
  },
}));

// Import AFTER the mocks are registered.
import { writeAudit } from '../src/shared/audit.js';
import { decryptJson, isCiphertext } from '../src/shared/encryption.js';

beforeEach(() => {
  created.length = 0;
  loggedErrors.length = 0;
  setLastEntryHash(null);
  prismaMock.auditLog.findFirst.mockClear();
  prismaMock.auditLog.create.mockClear();
  prismaMock.$transaction.mockClear();
  prismaMock.$executeRaw.mockClear();
});

// SVT-SEC-2026-08 (T0-7) — the audit write must set the tenant GUC.
//
// audit_logs carries the policy
//   USING/WITH CHECK (tenant_id = app_current_tenant() OR tenant_id IS NULL)
// so on a connection with no `app.tenant_id` every tenant-scoped insert fails
// the WITH CHECK. writeAudit swallows its own failures by design, so the
// tamper-evident chain this product sells as forensic integrity would have
// recorded nothing but system rows — silently — from the first day
// DATABASE_URL pointed at the de-privileged `spv_app` role. Dev and CI never
// saw it because RLS does not apply to the single superuser role they use.
describe('audit.writeAudit — tenant GUC (T0-7)', () => {
  it('sets app.tenant_id before inserting a tenant-scoped row', async () => {
    await writeAudit({
      tenantId: '11111111-1111-1111-1111-111111111111',
      action: 'student.updated',
      entityType: 'student',
    });

    expect(prismaMock.auditLog.create).toHaveBeenCalledTimes(1);
    // The GUC statement is what makes the row insertable at all.
    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('does not set a GUC for a system row, which lands via the tenant_id IS NULL branch', async () => {
    await writeAudit({
      tenantId: null,
      action: 'system.job.ran',
      entityType: 'job',
    });

    expect(prismaMock.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.$executeRaw).not.toHaveBeenCalled();
  });

  it('still writes independently of the caller, so a caller rollback cannot lose the row', async () => {
    // withTenantTx opens its own prisma.$transaction; the pre-existing
    // guarantee (audit survives business-code rollback) must be preserved.
    await writeAudit({
      tenantId: '11111111-1111-1111-1111-111111111111',
      action: 'student.updated',
      entityType: 'student',
    });
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe('audit.writeAudit — happy path', () => {
  it('inserts a row with the expected scalar fields', async () => {
    await writeAudit({
      tenantId: '11111111-1111-1111-1111-111111111111',
      actorId: '22222222-2222-2222-2222-222222222222',
      actorEmail: 'admin@example.com',
      action: 'auth.login.success',
      entityType: 'user',
      entityId: '22222222-2222-2222-2222-222222222222',
      entityVersion: 1,
      ip: '10.0.0.1',
      ua: 'vitest',
      requestId: 'req_abc',
    });

    expect(prismaMock.auditLog.create).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(1);

    const row = created[0]!;
    expect(row['action']).toBe('auth.login.success');
    expect(row['entity_type']).toBe('user');
    expect(row['tenant_id']).toBe('11111111-1111-1111-1111-111111111111');
    expect(row['request_id']).toBe('req_abc');
    expect(typeof row['actor_email_hash']).toBe('string');
    expect((row['actor_email_hash'] as string).length).toBe(64);
    expect(typeof row['ip_hash']).toBe('string');
    expect(typeof row['ua_hash']).toBe('string');
    expect(typeof row['entry_hash']).toBe('string');
    expect((row['entry_hash'] as string).length).toBe(64);
    expect(row['prev_hash']).toBeNull();
    expect(row['before_enc']).toBeNull();
    expect(row['after_enc']).toBeNull();
  });

  it('encrypts before/after as ciphertext blobs and they round-trip', async () => {
    const before = { stage: 'PRE_DEPARTURE', notes: 'old' };
    const after = { stage: 'IN_TRANSIT', notes: 'new' };
    await writeAudit({
      action: 'student.stage.change',
      entityType: 'student',
      entityId: '33333333-3333-3333-3333-333333333333',
      before,
      after,
    });

    const row = created[0]!;
    const beforeEnc = row['before_enc'] as Buffer;
    const afterEnc = row['after_enc'] as Buffer;
    expect(Buffer.isBuffer(beforeEnc)).toBe(true);
    expect(Buffer.isBuffer(afterEnc)).toBe(true);
    expect(isCiphertext(beforeEnc)).toBe(true);
    expect(isCiphertext(afterEnc)).toBe(true);
    await expect(decryptJson(beforeEnc)).resolves.toEqual(before);
    await expect(decryptJson(afterEnc)).resolves.toEqual(after);
  });

  it('chains entry_hash across successive writes (prev_hash links to last entry_hash)', async () => {
    await writeAudit({ action: 'a.1', entityType: 'x' });
    await writeAudit({ action: 'a.2', entityType: 'x' });

    expect(created).toHaveLength(2);
    const first = created[0]!;
    const second = created[1]!;
    expect(first['prev_hash']).toBeNull();
    expect(second['prev_hash']).toBe(first['entry_hash']);
    expect(second['entry_hash']).not.toBe(first['entry_hash']);
  });
});

describe('audit.writeAudit — failure swallowing', () => {
  it('logs and does not throw when encryption fails', async () => {
    // Force JSON.stringify to throw via a circular reference.
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;

    await expect(
      writeAudit({
        action: 'test.encryption.failure',
        entityType: 'x',
        before: cyclic,
      }),
    ).resolves.toBeUndefined();

    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
    expect(loggedErrors.length).toBeGreaterThan(0);
    expect(loggedErrors[0]!.msg).toMatch(/audit/i);
  });

  it('logs and does not throw when prisma.$transaction rejects', async () => {
    prismaMock.$transaction.mockImplementationOnce(async () => {
      throw new Error('db is down');
    });

    await expect(
      writeAudit({ action: 'test.db.down', entityType: 'x' }),
    ).resolves.toBeUndefined();

    expect(loggedErrors.length).toBeGreaterThan(0);
    expect(loggedErrors[0]!.msg).toMatch(/audit/i);
  });
});
