// SVT-WAVE12-NOTIFY-DEDUP-2026-05 — confirm notifyStatusTransition suppresses
// a duplicate within the 60-second window for the same (source, entity_id,
// recipient, body) tuple, but lets a different entity through.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MsgRow = {
  id: string;
  tenant_id: string;
  body: string;
  recipient_user_id: string | null;
  sent_at: Date | null;
  metadata: Record<string, unknown> | null;
};

const store = {
  messages: [] as MsgRow[],
  threads: [] as { id: string; tenant_id: string; student_id: string | null; channel: string; subject: string | null }[],
  admins: [{ id: 'admin-1', tenant_id: 'tenant-1', role: 'ADMIN', is_active: true, deleted_at: null, created_at: new Date() }],
};

vi.mock('../src/config/db.js', () => {
  const prisma = {
    user: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return store.admins.find((u) => u.tenant_id === where['tenant_id']) ?? null;
      }),
    },
    commsMessage: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const since = (where['sent_at'] as { gte?: Date } | undefined)?.gte;
        return store.messages.find((m) => {
          if (m.tenant_id !== where['tenant_id']) return false;
          if (m.recipient_user_id !== where['recipient_user_id']) return false;
          if (m.body !== where['body']) return false;
          if (since && (!m.sent_at || m.sent_at < since)) return false;
          return true;
        }) ?? null;
      }),
      create: vi.fn(async ({ data }: { data: MsgRow & { thread_id: string } }) => {
        const row = { ...data, id: `m-${store.messages.length + 1}` };
        store.messages.push(row);
        return row;
      }),
    },
    commsThread: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return store.threads.find((t) =>
          t.tenant_id === where['tenant_id'] &&
          t.student_id === where['student_id'] &&
          t.channel === where['channel'] &&
          t.subject === where['subject'],
        ) ?? null;
      }),
      create: vi.fn(async ({ data }: { data: { tenant_id: string; student_id: string | null; channel: string; subject: string | null } }) => {
        const row = { id: `t-${store.threads.length + 1}`, ...data };
        store.threads.push(row);
        return row;
      }),
    },
    $transaction: vi.fn(async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma)),
    $executeRaw: vi.fn(async () => 1),
  };
  return { prisma, disconnectDb: async () => undefined };
});

const { notifyStatusTransition, _clearTransitionNotifyCache } = await import('../src/shared/transitionNotify.js');

function resetStore() {
  store.messages.length = 0;
  store.threads.length = 0;
  _clearTransitionNotifyCache();
}

describe('notifyStatusTransition dedup', () => {
  beforeEach(() => resetStore());
  afterEach(() => vi.clearAllMocks());

  it('writes the first call and suppresses the duplicate within window', async () => {
    await notifyStatusTransition({
      tenantId: 'tenant-1',
      entityId: 'entity-A',
      title: 'Super-agent X → PAUSED',
      preferUserId: 'admin-1',
      source: 'super_agent',
    });
    expect(store.messages).toHaveLength(1);

    await notifyStatusTransition({
      tenantId: 'tenant-1',
      entityId: 'entity-A',
      title: 'Super-agent X → PAUSED',
      preferUserId: 'admin-1',
      source: 'super_agent',
    });
    expect(store.messages).toHaveLength(1); // suppressed
  });

  it('lets a different entity_id through within the same window', async () => {
    await notifyStatusTransition({
      tenantId: 'tenant-1',
      entityId: 'entity-A',
      title: 'Super-agent X → PAUSED',
      preferUserId: 'admin-1',
      source: 'super_agent',
    });
    await notifyStatusTransition({
      tenantId: 'tenant-1',
      entityId: 'entity-B', // different entity
      title: 'Super-agent X → PAUSED',
      preferUserId: 'admin-1',
      source: 'super_agent',
    });
    expect(store.messages).toHaveLength(2);
  });

  it('lets a different source through within the same window', async () => {
    await notifyStatusTransition({
      tenantId: 'tenant-1',
      entityId: 'entity-A',
      title: 'X',
      preferUserId: 'admin-1',
      source: 'super_agent',
    });
    await notifyStatusTransition({
      tenantId: 'tenant-1',
      entityId: 'entity-A',
      title: 'X',
      preferUserId: 'admin-1',
      source: 'enrollment', // different source
    });
    expect(store.messages).toHaveLength(2);
  });

  it('allows the same notification after the window elapses', async () => {
    await notifyStatusTransition({
      tenantId: 'tenant-1',
      entityId: 'entity-A',
      title: 'Super-agent X → PAUSED',
      preferUserId: 'admin-1',
      source: 'super_agent',
    });
    // Backdate sent_at past the dedup window.
    store.messages[0]!.sent_at = new Date(Date.now() - 5 * 60_000);
    await notifyStatusTransition({
      tenantId: 'tenant-1',
      entityId: 'entity-A',
      title: 'Super-agent X → PAUSED',
      preferUserId: 'admin-1',
      source: 'super_agent',
    });
    expect(store.messages).toHaveLength(2);
  });
});
