// SVT-WAVE-PRIV-C6-2026-05 — retention erasure must additionally null every
// *_enc Bytes column on the affected Document row. The Document model has
// no *_enc columns today; the job discovers them via Prisma DMMF + a test
// seam (__setEncColumnsForTests) lets us simulate a future schema with one.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');

type DocRow = {
  id: string;
  tenant_id: string;
  storage_key: string;
  deleted_at: Date | null;
  retention_until: Date | null;
  inline_blob_enc: Buffer; // simulated future column
};

const store = { docs: [] as DocRow[], storageDeletes: [] as string[] };

vi.mock('../src/config/db.js', () => {
  const prisma = {
    document: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const ret = (where['retention_until'] as { lte?: Date } | undefined)?.lte;
        const filter = (d: DocRow) =>
          d.deleted_at == null &&
          (ret ? d.retention_until != null && d.retention_until <= ret : true);
        return store.docs.filter(filter).map((d) => ({
          id: d.id,
          storage_key: d.storage_key,
          tenant_id: d.tenant_id,
        }));
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        let count = 0;
        for (const d of store.docs) {
          if (d.id !== where['id']) continue;
          if (d.tenant_id !== where['tenant_id']) continue;
          for (const [k, v] of Object.entries(data)) {
            (d as unknown as Record<string, unknown>)[k] = v;
          }
          count++;
        }
        return { count };
      }),
    },
  };
  // SVT-SEC-2026-08 (T0-7) — jobs now scope their work: cross-tenant discovery
  // reads go through prismaAdmin (BYPASSRLS) and per-tenant writes run inside
  // withTenantTx, which opens a transaction and issues
  // `SELECT set_config('app.tenant_id', …)` first. Without the GUC the RLS
  // policies match zero rows under the production role and the job silently
  // does nothing.
  (prisma as Record<string, unknown>)['$transaction'] =
    vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma));
  (prisma as Record<string, unknown>)['$executeRaw'] = vi.fn(async () => 1);
  return { prisma, prismaAdmin: prisma, disconnectDb: async () => undefined };
});

vi.mock('../src/modules/documents/storage.js', () => ({
  getStorage: () => ({
    put: vi.fn(async () => undefined),
    get: vi.fn(async () => Buffer.alloc(0)),
    delete: vi.fn(async (key: string) => {
      store.storageDeletes.push(key);
    }),
    exists: vi.fn(async () => true),
  }),
  buildStorageKey: vi.fn(() => 'key'),
  sha256Hex: vi.fn(() => 'hash'),
}));

vi.mock('../src/shared/audit.js', () => ({ writeAudit: vi.fn(async () => undefined) }));

vi.mock('../src/config/sentry.js', () => ({
  captureJobException: vi.fn(),
  withTenantScope: vi.fn(async (_t: string, _j: string, fn: () => Promise<unknown>) => fn()),
}));

const { runRetentionErasure, __setEncColumnsForTests } = await import('../src/jobs/retentionErasure.js');

beforeEach(() => {
  store.docs.length = 0;
  store.storageDeletes.length = 0;
  __setEncColumnsForTests(null);
});

describe('runRetentionErasure crypto-shred (SVT-WAVE-PRIV-C6-2026-05)', () => {
  it('overwrites *_enc Bytes columns with an empty buffer post-expiry', async () => {
    __setEncColumnsForTests(['inline_blob_enc']);
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    store.docs.push({
      id: 'd1',
      tenant_id: 't1',
      storage_key: 't1/x/2024/01/d1.pdf',
      deleted_at: null,
      retention_until: yesterday,
      inline_blob_enc: Buffer.from('originalsecretciphertext'),
    });

    const r = await runRetentionErasure({});
    expect(r.shredded).toBe(1);
    expect(r.errors).toBe(0);
    expect(store.docs[0]!.deleted_at).toBeInstanceOf(Date);
    // The crypto-shred: the *_enc column is now a 0-byte Buffer.
    expect(Buffer.isBuffer(store.docs[0]!.inline_blob_enc)).toBe(true);
    expect(store.docs[0]!.inline_blob_enc.length).toBe(0);
    expect(store.storageDeletes).toContain('t1/x/2024/01/d1.pdf');
  });

  it('current schema (no *_enc Bytes columns) still deletes the storage object', async () => {
    // DMMF discovery for live Document returns []. The shred step is a
    // no-op because there are no columns to null, but storage.delete still
    // fires and deleted_at is stamped.
    __setEncColumnsForTests([]);
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    store.docs.push({
      id: 'd2',
      tenant_id: 't2',
      storage_key: 't2/y/2024/02/d2.pdf',
      deleted_at: null,
      retention_until: yesterday,
      inline_blob_enc: Buffer.from('unused'),
    });

    const r = await runRetentionErasure({});
    expect(r.shredded).toBe(1);
    expect(store.docs[0]!.deleted_at).toBeInstanceOf(Date);
    expect(store.storageDeletes).toContain('t2/y/2024/02/d2.pdf');
  });

  it('leaves rows whose retention_until is still in the future untouched', async () => {
    __setEncColumnsForTests(['inline_blob_enc']);
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    store.docs.push({
      id: 'd3',
      tenant_id: 't3',
      storage_key: 't3/z/2024/03/d3.pdf',
      deleted_at: null,
      retention_until: tomorrow,
      inline_blob_enc: Buffer.from('intact'),
    });

    const r = await runRetentionErasure({});
    expect(r.shredded).toBe(0);
    expect(store.docs[0]!.deleted_at).toBeNull();
    expect(store.docs[0]!.inline_blob_enc.toString('utf8')).toBe('intact');
  });
});
