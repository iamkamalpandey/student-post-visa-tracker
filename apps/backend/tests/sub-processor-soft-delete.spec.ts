// SVT-WAVE-PRIV-C2-2026-05 — sub-processor service soft-delete + include_removed
// filter. Verifies:
//   * remove() stamps removed_at instead of hard-deleting,
//   * list() defaults to active rows (removed_at IS NULL),
//   * list({ include_removed: true }) returns the full history,
//   * audit row uses the new `sub_processor.removed` action.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');

type SpRow = {
  id: string;
  tenant_id: string;
  name: string;
  purpose: string;
  region: string;
  contract_url: string | null;
  added_at: Date;
  removed_at: Date | null;
};

const store = { rows: [] as SpRow[] };
const audit: Array<{ action: string; entityId: string | null }> = [];

function matches(row: SpRow, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (v === null) {
      if ((row as unknown as Record<string, unknown>)[k] != null) return false;
      continue;
    }
    if (v === undefined) continue;
    if ((row as unknown as Record<string, unknown>)[k] !== v) return false;
  }
  return true;
}

vi.mock('../src/config/db.js', () => {
  const prisma = {
    subProcessor: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row: SpRow = {
          id: randomUUID(),
          tenant_id: String(data['tenant_id']),
          name: String(data['name']),
          purpose: String(data['purpose']),
          region: String(data['region']),
          contract_url: (data['contract_url'] as string | null) ?? null,
          added_at: new Date(),
          removed_at: null,
        };
        store.rows.push(row);
        return row;
      }),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        store.rows.find((r) => matches(r, where)) ?? null,
      ),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        store.rows.filter((r) => matches(r, where)),
      ),
      findFirstOrThrow: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const r = store.rows.find((row) => matches(row, where));
        if (!r) throw new Error('not found');
        return r;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        let count = 0;
        for (const r of store.rows) {
          if (!matches(r, where)) continue;
          for (const [k, v] of Object.entries(data)) {
            (r as unknown as Record<string, unknown>)[k] = v;
          }
          count++;
        }
        return { count };
      }),
      deleteMany: vi.fn(async () => ({ count: 0 })), // deliberately unused
    },
  };
  return { prisma, disconnectDb: async () => undefined };
});

vi.mock('../src/shared/audit.js', () => ({
  writeAudit: vi.fn(async (...args: unknown[]) => {
    const ev = (args.length === 2 ? args[1] : args[0]) as { action: string; entityId?: string | null };
    audit.push({ action: ev.action, entityId: ev.entityId ?? null });
  }),
}));

const { subProcessorService } = await import('../src/modules/sub-processors/service.js');

const TENANT = '11111111-1111-7111-8111-111111111111';
const req = { user: { tid: TENANT } } as Parameters<typeof subProcessorService.list>[0];

beforeEach(() => {
  store.rows.length = 0;
  audit.length = 0;
});

describe('sub-processor soft-delete (SVT-WAVE-PRIV-C2-2026-05)', () => {
  it('remove() stamps removed_at and writes a sub_processor.removed audit row', async () => {
    const created = await subProcessorService.create(req, {
      name: 'Adventus',
      purpose: 'Student aggregator',
      region: 'EU',
    });
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]!.removed_at).toBeNull();

    await subProcessorService.remove(req, created.id);

    // Row survives — Art. 30(2) requires the history.
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]!.removed_at).toBeInstanceOf(Date);
    // Audit chain uses the `removed` verb, not `deleted`.
    const removedAudit = audit.find((a) => a.action === 'sub_processor.removed');
    expect(removedAudit).toBeDefined();
    expect(removedAudit?.entityId).toBe(created.id);
  });

  it('list() default hides removed rows', async () => {
    await subProcessorService.create(req, { name: 'Postmark', purpose: 'Email delivery', region: 'US' });
    const toRemove = await subProcessorService.create(req, { name: 'Twilio', purpose: 'SMS', region: 'US' });
    await subProcessorService.remove(req, toRemove.id);

    const list = await subProcessorService.list(req, { limit: 50 } as never);
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe('Postmark');
  });

  it('list({ include_removed: true }) returns the full history', async () => {
    await subProcessorService.create(req, { name: 'Postmark', purpose: 'Email delivery', region: 'US' });
    const toRemove = await subProcessorService.create(req, { name: 'Twilio', purpose: 'SMS', region: 'US' });
    await subProcessorService.remove(req, toRemove.id);

    const all = await subProcessorService.list(req, { limit: 50, include_removed: true } as never);
    expect(all).toHaveLength(2);
    const twilio = all.find((r) => r.name === 'Twilio')!;
    expect(twilio.removed_at).toBeInstanceOf(Date);
  });

  it('double-remove resolves to 404 (no duplicate audit row)', async () => {
    const created = await subProcessorService.create(req, { name: 'Adventus', purpose: 'Agg', region: 'EU' });
    await subProcessorService.remove(req, created.id);
    await expect(subProcessorService.remove(req, created.id)).rejects.toMatchObject({ status: 404 });
    const removedAudits = audit.filter((a) => a.action === 'sub_processor.removed');
    expect(removedAudits).toHaveLength(1);
  });
});
