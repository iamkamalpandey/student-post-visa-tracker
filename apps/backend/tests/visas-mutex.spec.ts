// SVT-FSM-2026-05: visaService active-flag mutex tests.
//
// Drives visaService.create() / .update() with a hand-rolled prisma client
// whose $transaction passes through to a tx that wraps an in-memory store.
// We assert that flipping a new visa to is_active=true causes any sibling
// active visas (same student) to flip to is_active=false in the same call,
// and that an audit row is emitted per auto-deactivated sibling.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3000');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('JWT_PRIVATE_KEY', '-----BEGIN PRIVATE KEY-----\nstub\n-----END PRIVATE KEY-----');
vi.stubEnv('JWT_PUBLIC_KEY', '-----BEGIN PUBLIC KEY-----\nstub\n-----END PUBLIC KEY-----');
vi.stubEnv('JWT_KID', 'test');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

vi.mock('../src/shared/encryption.js', () => ({
  encryptField: async (s: string | Buffer) =>
    Buffer.from(typeof s === 'string' ? s : s.toString('utf8'), 'utf8'),
  decryptField: async (b: Buffer) => b.toString('utf8'),
  encryptJson: async (v: unknown) => Buffer.from(JSON.stringify(v ?? null), 'utf8'),
  decryptJson: async (b: Buffer) => JSON.parse(b.toString('utf8')),
}));

const auditCalls: Array<{ action: string; entityId: string | null }> = [];
vi.mock('../src/shared/audit.js', () => ({
  writeAudit: vi.fn(async (...args: unknown[]) => {
    const ev = (args.length === 2 ? args[1] : args[0]) as {
      action: string;
      entityId?: string | null;
      entity_id?: string | null;
    };
    auditCalls.push({ action: ev.action, entityId: ev.entityId ?? ev.entity_id ?? null });
  }),
}));

type Row = {
  id: string;
  tenant_id: string;
  student_id: string;
  is_active: boolean;
  visa_number_enc?: Buffer;
  destination_country?: string;
  visa_category_id?: string;
  issued_on?: Date;
  expires_on?: Date;
  created_at: Date;
  updated_at: Date;
};
const store: Row[] = [];

function studentVisaDelegate() {
  return {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const r: Row = {
        id: (data['id'] as string) ?? randomUUID(),
        tenant_id: data['tenant_id'] as string,
        student_id: data['student_id'] as string,
        is_active: (data['is_active'] as boolean | undefined) ?? true,
        visa_number_enc: data['visa_number_enc'] as Buffer | undefined,
        destination_country: data['destination_country'] as string | undefined,
        visa_category_id: data['visa_category_id'] as string | undefined,
        issued_on: data['issued_on'] as Date | undefined,
        expires_on: data['expires_on'] as Date | undefined,
        created_at: new Date(),
        updated_at: new Date(),
      };
      store.push(r);
      return r;
    }),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      return store.find((r) => r.id === where['id'] && r.tenant_id === where['tenant_id']) ?? null;
    }),
    findFirstOrThrow: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const r = store.find((x) => x.id === where['id'] && x.tenant_id === where['tenant_id']);
      if (!r) throw new Error('not found');
      return r;
    }),
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      return store.filter((r) => {
        if (where['tenant_id'] !== undefined && r.tenant_id !== where['tenant_id']) return false;
        if (where['student_id'] !== undefined && r.student_id !== where['student_id']) return false;
        if (where['is_active'] !== undefined && r.is_active !== where['is_active']) return false;
        const idF = where['id'] as { not?: string } | string | undefined;
        if (typeof idF === 'string' && r.id !== idF) return false;
        if (idF && typeof idF === 'object' && 'not' in idF && r.id === idF.not) return false;
        return true;
      });
    }),
    updateMany: vi.fn(
      async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        let count = 0;
        for (const r of store) {
          if (where['tenant_id'] !== undefined && r.tenant_id !== where['tenant_id']) continue;
          if (where['student_id'] !== undefined && r.student_id !== where['student_id']) continue;
          if (where['is_active'] !== undefined && r.is_active !== where['is_active']) continue;
          const idF = where['id'] as { not?: string } | string | undefined;
          if (typeof idF === 'string' && r.id !== idF) continue;
          if (idF && typeof idF === 'object' && 'not' in idF && r.id === idF.not) continue;
          Object.assign(r, data, { updated_at: new Date() });
          count++;
        }
        return { count };
      },
    ),
    deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const before = store.length;
      for (let i = store.length - 1; i >= 0; i--) {
        const r = store[i]!;
        if (where['id'] !== undefined && r.id !== where['id']) continue;
        if (where['tenant_id'] !== undefined && r.tenant_id !== where['tenant_id']) continue;
        store.splice(i, 1);
      }
      return { count: before - store.length };
    }),
  };
}

let prismaClient: {
  studentVisa: ReturnType<typeof studentVisaDelegate>;
  $transaction: ReturnType<typeof vi.fn>;
};

vi.mock('../src/config/db.js', () => {
  const mk = () => {
    const visa = studentVisaDelegate();
    const client = {
      studentVisa: visa,
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ studentVisa: visa }),
      ),
    };
    return client;
  };
  prismaClient = mk();
  return { prisma: prismaClient, disconnectDb: async () => undefined };
});

const { visaService } = await import('../src/modules/visas/service.js');

const TENANT = '11111111-1111-7111-8111-111111111111';
const STUDENT = '22222222-2222-7222-8222-222222222222';
const ACTOR = '33333333-3333-7333-8333-333333333333';

function reqCtx() {
  return { user: { tid: TENANT, sub: ACTOR } } as unknown as Parameters<typeof visaService.create>[0];
}

beforeEach(() => {
  store.length = 0;
  auditCalls.length = 0;
});

describe('visaService active-flag mutex', () => {
  it('creating a second active visa deactivates the first one in the same call', async () => {
    // Seed an existing active visa for the student.
    const existing: Row = {
      id: randomUUID(),
      tenant_id: TENANT,
      student_id: STUDENT,
      is_active: true,
      created_at: new Date(),
      updated_at: new Date(),
    };
    store.push(existing);

    const created = await visaService.create(reqCtx(), STUDENT, {
      visa_category_id: '44444444-4444-7444-8444-444444444444',
      destination_country: 'GB',
      visa_number: 'AB123456',
      issued_on: '2026-01-01',
      expires_on: '2030-01-01',
    } as never);

    expect((created as Row).is_active).toBe(true);
    // Sibling must have been flipped to false.
    const sibling = store.find((r) => r.id === existing.id)!;
    expect(sibling.is_active).toBe(false);
    // Audit row for the auto-deactivation was emitted.
    expect(
      auditCalls.some(
        (c) => c.action === 'visa.auto_deactivated_due_to_new_active' && c.entityId === existing.id,
      ),
    ).toBe(true);
  });

  it('PATCH flipping is_active=true on a sibling deactivates the prior active visa', async () => {
    // Two visas: one currently active, one inactive.
    const active: Row = {
      id: randomUUID(),
      tenant_id: TENANT,
      student_id: STUDENT,
      is_active: true,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const inactive: Row = {
      id: randomUUID(),
      tenant_id: TENANT,
      student_id: STUDENT,
      is_active: false,
      created_at: new Date(),
      updated_at: new Date(),
    };
    store.push(active, inactive);

    await visaService.update(reqCtx(), inactive.id, { is_active: true } as never);

    expect(store.find((r) => r.id === inactive.id)!.is_active).toBe(true);
    expect(store.find((r) => r.id === active.id)!.is_active).toBe(false);
    expect(
      auditCalls.some(
        (c) => c.action === 'visa.auto_deactivated_due_to_new_active' && c.entityId === active.id,
      ),
    ).toBe(true);
  });

  it('creating an inactive visa leaves the existing active one alone', async () => {
    const existing: Row = {
      id: randomUUID(),
      tenant_id: TENANT,
      student_id: STUDENT,
      is_active: true,
      created_at: new Date(),
      updated_at: new Date(),
    };
    store.push(existing);

    await visaService.create(reqCtx(), STUDENT, {
      visa_category_id: '44444444-4444-7444-8444-444444444444',
      destination_country: 'GB',
      visa_number: 'AB-OLD',
      issued_on: '2025-01-01',
      expires_on: '2026-12-31',
      is_active: false,
    } as never);

    expect(store.find((r) => r.id === existing.id)!.is_active).toBe(true);
    expect(
      auditCalls.some((c) => c.action === 'visa.auto_deactivated_due_to_new_active'),
    ).toBe(false);
  });
});
