// SVT-WAVE-PRIV-C3-2026-05 — DSAR 30-day SLA watchdog. Verifies:
//   * non-terminal rows past due_by are transitioned to EXPIRED,
//   * terminal rows (COMPLETED/REJECTED/EXPIRED) are left alone,
//   * rows whose due_by is still in the future are untouched,
//   * an audit row + IN_APP notification are emitted per expiry.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');

type DsarRow = {
  id: string;
  tenant_id: string;
  status: string;
  due_by: Date;
  type: string;
  subject_id: string;
};

const store = { rows: [] as DsarRow[] };
const audit: Array<{ action: string; entityId: string | null; after?: unknown }> = [];
const notifications: Array<{ tenantId: string; source: string; entityId: string }> = [];

function matchesNonTerminal(row: DsarRow, terminalList: string[]): boolean {
  return !terminalList.includes(row.status);
}

vi.mock('../src/config/db.js', () => {
  const prisma = {
    dSARRequest: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const statusNotIn = (where['status'] as { notIn?: string[] } | undefined)?.notIn ?? [];
        const dueLt = (where['due_by'] as { lt?: Date } | undefined)?.lt;
        return store.rows
          .filter((r) => (statusNotIn.length === 0 || matchesNonTerminal(r, statusNotIn)))
          .filter((r) => (dueLt ? r.due_by < dueLt : true))
          .map((r) => ({ id: r.id, tenant_id: r.tenant_id, type: r.type, subject_id: r.subject_id }));
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const id = where['id'];
        const statusNotIn = (where['status'] as { notIn?: string[] } | undefined)?.notIn ?? [];
        let count = 0;
        for (const r of store.rows) {
          if (r.id !== id) continue;
          if (statusNotIn.length > 0 && !matchesNonTerminal(r, statusNotIn)) continue;
          for (const [k, v] of Object.entries(data)) {
            (r as unknown as Record<string, unknown>)[k] = v;
          }
          count++;
        }
        return { count };
      }),
    },
  };
  return { prisma, disconnectDb: async () => undefined };
});

vi.mock('../src/shared/audit.js', () => ({
  writeAudit: vi.fn(async (...args: unknown[]) => {
    const ev = (args.length === 2 ? args[1] : args[0]) as { action: string; entityId?: string | null; after?: unknown };
    audit.push({ action: ev.action, entityId: ev.entityId ?? null, after: ev.after });
  }),
}));

vi.mock('../src/shared/transitionNotify.js', () => ({
  notifyStatusTransition: vi.fn(async (args: { tenantId: string; source: string; entityId: string }) => {
    notifications.push({ tenantId: args.tenantId, source: args.source, entityId: args.entityId });
  }),
}));

vi.mock('../src/config/sentry.js', () => ({
  captureJobException: vi.fn(),
  withTenantScope: vi.fn(async (_t: string, _j: string, fn: () => Promise<unknown>) => fn()),
  startJobSpan: vi.fn(async (_n: string, fn: () => Promise<unknown>) => fn()),
}));

const { runDsarSlaWatch } = await import('../src/jobs/dsarSlaWatch.js');

const TENANT = '11111111-1111-7111-8111-111111111111';
const ago = (ms: number) => new Date(Date.now() - ms);
const ahead = (ms: number) => new Date(Date.now() + ms);

function mk(overrides: Partial<DsarRow> = {}): DsarRow {
  return {
    id: randomUUID(),
    tenant_id: TENANT,
    status: 'IN_PROGRESS',
    due_by: ago(24 * 60 * 60 * 1000), // 1 day overdue
    type: 'ACCESS',
    subject_id: randomUUID(),
    ...overrides,
  };
}

beforeEach(() => {
  store.rows.length = 0;
  audit.length = 0;
  notifications.length = 0;
});

describe('runDsarSlaWatch (SVT-WAVE-PRIV-C3-2026-05)', () => {
  it('transitions overdue non-terminal rows to EXPIRED + audits + notifies', async () => {
    const row = mk();
    store.rows.push(row);

    const r = await runDsarSlaWatch();
    expect(r.scanned).toBe(1);
    expect(r.expired).toBe(1);
    expect(r.errors).toBe(0);
    expect(row.status).toBe('EXPIRED');

    const expAudit = audit.find((a) => a.action === 'dsar.expired.auto');
    expect(expAudit).toBeDefined();
    expect(expAudit?.entityId).toBe(row.id);

    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.source).toBe('dsar');
    expect(notifications[0]!.entityId).toBe(row.id);
  });

  it('leaves terminal rows alone (COMPLETED / REJECTED / EXPIRED)', async () => {
    store.rows.push(mk({ status: 'COMPLETED', due_by: ago(99 * 24 * 60 * 60 * 1000) }));
    store.rows.push(mk({ status: 'REJECTED', due_by: ago(99 * 24 * 60 * 60 * 1000) }));
    store.rows.push(mk({ status: 'EXPIRED', due_by: ago(99 * 24 * 60 * 60 * 1000) }));

    const r = await runDsarSlaWatch();
    expect(r.scanned).toBe(0);
    expect(r.expired).toBe(0);
    expect(audit).toHaveLength(0);
  });

  it('leaves rows whose due_by is still in the future untouched', async () => {
    const row = mk({ due_by: ahead(5 * 24 * 60 * 60 * 1000) });
    store.rows.push(row);
    const r = await runDsarSlaWatch();
    expect(r.scanned).toBe(0);
    expect(row.status).toBe('IN_PROGRESS');
  });

  it('idempotent re-run is a no-op', async () => {
    store.rows.push(mk());
    await runDsarSlaWatch();
    const second = await runDsarSlaWatch();
    expect(second.scanned).toBe(0);
    expect(second.expired).toBe(0);
  });
});
