// SVT-WAVE13-CLEANUP-2026-05 — comms cleanup job purges SENT/READ rows older
// than 30d. QUEUED/FAILED kept; recent rows kept; inbound kept.

import { beforeEach, describe, expect, it, vi } from 'vitest';

type MsgRow = {
  id: string;
  status: string;
  direction: string;
  sent_at: Date | null;
};

const store = { messages: [] as MsgRow[] };

vi.mock('../src/config/db.js', () => {
  const prisma = {
    commsMessage: {
      findMany: vi.fn(async ({ where, take }: { where: Record<string, unknown>; take?: number }) => {
        const statusIn = (where['status'] as { in?: string[] } | undefined)?.in ?? [];
        const direction = where['direction'];
        const sentLt = (where['sent_at'] as { lt?: Date } | undefined)?.lt;
        const rows = store.messages.filter((m) => {
          if (statusIn.length && !statusIn.includes(m.status)) return false;
          if (direction && m.direction !== direction) return false;
          if (sentLt && (m.sent_at == null || m.sent_at >= sentLt)) return false;
          return true;
        }).map((m) => ({ id: m.id }));
        return take ? rows.slice(0, take) : rows;
      }),
      deleteMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
        const ids = new Set(where.id.in);
        const before = store.messages.length;
        store.messages = store.messages.filter((m) => !ids.has(m.id));
        return { count: before - store.messages.length };
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

const { runCommsCleanup } = await import('../src/jobs/commsCleanup.js');

const ago = (days: number) => new Date(Date.now() - days * 24 * 60 * 60_000);

describe('runCommsCleanup', () => {
  beforeEach(() => {
    store.messages = [];
  });

  it('deletes SENT/READ/DELIVERED rows older than 30 days', async () => {
    store.messages.push(
      { id: '1', status: 'SENT', direction: 'OUTBOUND', sent_at: ago(45) },
      { id: '2', status: 'READ', direction: 'OUTBOUND', sent_at: ago(60) },
      { id: '3', status: 'DELIVERED', direction: 'OUTBOUND', sent_at: ago(31) },
    );
    const r = await runCommsCleanup();
    expect(r.deleted).toBe(3);
    expect(store.messages).toHaveLength(0);
  });

  it('keeps rows newer than 30 days', async () => {
    store.messages.push(
      { id: '1', status: 'SENT', direction: 'OUTBOUND', sent_at: ago(29) },
      { id: '2', status: 'SENT', direction: 'OUTBOUND', sent_at: ago(10) },
    );
    const r = await runCommsCleanup();
    expect(r.deleted).toBe(0);
    expect(store.messages).toHaveLength(2);
  });

  it('keeps QUEUED + FAILED rows regardless of age', async () => {
    store.messages.push(
      { id: '1', status: 'QUEUED', direction: 'OUTBOUND', sent_at: ago(60) },
      { id: '2', status: 'FAILED', direction: 'OUTBOUND', sent_at: ago(60) },
    );
    const r = await runCommsCleanup();
    expect(r.deleted).toBe(0);
    expect(store.messages).toHaveLength(2);
  });

  it('keeps INBOUND messages regardless of age + status', async () => {
    store.messages.push(
      { id: '1', status: 'SENT', direction: 'INBOUND', sent_at: ago(60) },
    );
    const r = await runCommsCleanup();
    expect(r.deleted).toBe(0);
    expect(store.messages).toHaveLength(1);
  });
});
