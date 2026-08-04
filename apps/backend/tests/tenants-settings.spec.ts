// SVT-WAVE17-TENANT-2026-05 — GET + PATCH /tenants/me.

import { beforeEach, describe, expect, it, vi } from 'vitest';

type TenantRow = {
  id: string;
  name: string;
  legal_name: string | null;
  default_locale: string;
  default_timezone: string;
  default_currency: string;
  data_residency_region: string;
  email_from: string | null;
};

const store = { tenants: [] as TenantRow[] };

vi.mock('../src/config/db.js', () => {
  const prisma = {
    tenant: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
        store.tenants.find((t) => t.id === where.id) ?? null,
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const t = store.tenants.find((x) => x.id === where.id);
        if (!t) return null;
        for (const [k, v] of Object.entries(data)) (t as Record<string, unknown>)[k] = v as never;
        return t;
      }),
    },
    // SVT-QA-2026-08 — the tenants service routes every read/write through
    // `withTenantTx`, which opens a transaction and `set_config`s the
    // app.tenant_id GUC before touching the row (the tenants-table RLS policy
    // requires it). The fixture must therefore model both primitives; without
    // them every case failed with "prisma.$transaction is not a function".
    $transaction: vi.fn(async (fn: unknown) =>
      typeof fn === 'function' ? (fn as (tx: unknown) => unknown)(prisma) : fn),
    $executeRaw: vi.fn(async () => 1),
  };
  return {
    prisma,
    prismaAdmin: { user: { findUnique: async () => ({ sessions_valid_from: null }) } },
    disconnectDb: async () => undefined,
  };
});

vi.mock('../src/shared/audit.js', () => ({ writeAudit: vi.fn(async () => undefined) }));

const { tenantSettingsService } = await import('../src/modules/tenants/service.js');

const TENANT_ID = 'tenant-1';

function seed(opts: Partial<TenantRow> = {}): TenantRow {
  const t: TenantRow = {
    id: TENANT_ID, name: 'Default Tenant', legal_name: null,
    default_locale: 'en', default_timezone: 'UTC', default_currency: 'USD',
    data_residency_region: 'eu-west-1', email_from: null,
    ...opts,
  };
  store.tenants.push(t);
  return t;
}

describe('tenantSettingsService', () => {
  beforeEach(() => { store.tenants.length = 0; });

  it('getMe returns the tenant snapshot shaped for the response', async () => {
    seed();
    const r = await tenantSettingsService.getMe(TENANT_ID);
    expect(r.id).toBe(TENANT_ID);
    expect(r.email_from).toBeNull();
  });

  it('updateMe persists email_from', async () => {
    seed();
    const r = await tenantSettingsService.updateMe(TENANT_ID, { email_from: 'a@b.test' });
    expect(r.email_from).toBe('a@b.test');
    expect(store.tenants[0]!.email_from).toBe('a@b.test');
  });

  it('updateMe(email_from=null) clears the field', async () => {
    seed({ email_from: 'x@y.test' });
    const r = await tenantSettingsService.updateMe(TENANT_ID, { email_from: null });
    expect(r.email_from).toBeNull();
  });

  it('updateMe with empty patch is a no-op (returns current state)', async () => {
    seed({ email_from: 'x@y.test' });
    const r = await tenantSettingsService.updateMe(TENANT_ID, {});
    expect(r.email_from).toBe('x@y.test');
  });

  it('getMe throws NotFound when tenant is missing', async () => {
    await expect(tenantSettingsService.getMe('no-such-tenant')).rejects.toThrowError(/Tenant not found/);
  });
});
