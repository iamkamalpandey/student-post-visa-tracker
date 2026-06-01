// commsDispatcher outbox unit tests. Mocks prisma + provider registry so we
// exercise the QUEUED → SENT/FAILED flip + retry-backoff path in isolation.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MsgRow = {
  id: string;
  tenant_id: string;
  thread_id: string;
  recipient_user_id: string | null;
  subject: string | null;
  body: string;
  status: string;
  attempts: number;
  metadata: Record<string, unknown> | null;
  last_attempt_at?: Date | null;
  next_retry_at?: Date | null;
  provider_id?: string | null;
  sent_at?: Date | null;
};

const store = {
  messages: [] as MsgRow[],
  threads: [{ id: 'thread-1', channel: 'EMAIL' }],
  users: [
    { id: 'user-1', email: 'ok@example.com', notifications_email_enabled: true, is_active: true, deleted_at: null },
    { id: 'user-2', email: 'optout@example.com', notifications_email_enabled: false, is_active: true, deleted_at: null },
  ],
};

const providerSend = vi.fn();

vi.mock('../src/config/db.js', () => {
  const messages = {
    findMany: vi.fn(async ({ take }: { take?: number }) => {
      const now = new Date();
      const rows = store.messages.filter((m) => {
        if (m.status === 'QUEUED') return true;
        if (m.status === 'FAILED' && m.attempts < 3 && m.next_retry_at && m.next_retry_at <= now) return true;
        return false;
      });
      return rows.slice(0, take ?? 100);
    }),
    updateMany: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const m = store.messages.find((x) => x.id === where.id);
      if (!m) return { count: 0 };
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === 'object' && (v as { increment?: number }).increment !== undefined) {
          (m as Record<string, unknown>)[k] = ((m as Record<string, unknown>)[k] as number) + (v as { increment: number }).increment;
        } else {
          (m as Record<string, unknown>)[k] = v as never;
        }
      }
      return { count: 1 };
    }),
  };
  const threads = {
    findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
      return store.threads.find((t) => t.id === where.id) ?? null;
    }),
  };
  const users = {
    findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
      return store.users.find((u) => u.id === where.id) ?? null;
    }),
  };
  const tenants = {
    // Wave 15: per-tenant FROM lookup. Return null = fall back to env.EMAIL_FROM.
    findFirst: vi.fn(async () => ({ email_from: null })),
    // SVT-TENANT-ISO-2026-05 — dispatcher now scopes candidate scan per-tenant.
    findMany: vi.fn(async () => [{ id: 't1' }]),
  };
  const prisma = {
    commsMessage: messages,
    commsThread: threads,
    user: users,
    tenant: tenants,
    $transaction: vi.fn(async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma)),
    $executeRaw: vi.fn(async () => 1),
  };
  return { prisma, disconnectDb: async () => undefined };
});

vi.mock('../src/modules/comms/providers/registry.js', () => ({
  getProvider: () => ({ channel: 'EMAIL', send: providerSend }),
}));

const { dispatchCommsOutbox } = await import('../src/jobs/commsDispatcher.js');

function resetStore() {
  store.messages.length = 0;
  providerSend.mockReset();
}

describe('commsDispatcher.dispatchCommsOutbox', () => {
  beforeEach(() => resetStore());
  afterEach(() => vi.clearAllMocks());

  it('marks QUEUED → SENT when provider returns SENT', async () => {
    store.messages.push({
      id: 'm1', tenant_id: 't1', thread_id: 'thread-1', recipient_user_id: 'user-1',
      subject: 'Test', body: 'hello', status: 'QUEUED', attempts: 0, metadata: null,
    });
    providerSend.mockResolvedValueOnce({ providerId: 'resend-1', status: 'SENT' });

    const r = await dispatchCommsOutbox();
    expect(r.sent).toBe(1);
    expect(r.failed).toBe(0);
    expect(store.messages[0]!.status).toBe('SENT');
    expect(store.messages[0]!.provider_id).toBe('resend-1');
    expect(store.messages[0]!.attempts).toBe(1);
  });

  it('marks SENT (no-op) when recipient opted out of email', async () => {
    store.messages.push({
      id: 'm2', tenant_id: 't1', thread_id: 'thread-1', recipient_user_id: 'user-2',
      subject: 'X', body: 'y', status: 'QUEUED', attempts: 0, metadata: null,
    });

    const r = await dispatchCommsOutbox();
    expect(r.opted_out).toBe(1);
    expect(providerSend).not.toHaveBeenCalled();
    expect(store.messages[0]!.status).toBe('SENT');
  });

  it('flips to FAILED + sets next_retry_at on provider failure (attempts < MAX)', async () => {
    store.messages.push({
      id: 'm3', tenant_id: 't1', thread_id: 'thread-1', recipient_user_id: 'user-1',
      subject: 'X', body: 'y', status: 'QUEUED', attempts: 0, metadata: null,
    });
    providerSend.mockResolvedValueOnce({ providerId: '', status: 'FAILED', error: 'upstream 500' });

    const now = new Date('2026-05-17T00:00:00Z');
    const r = await dispatchCommsOutbox(undefined, now);
    expect(r.failed).toBe(1);
    expect(r.terminal).toBe(0);
    const m = store.messages[0]!;
    expect(m.status).toBe('FAILED');
    expect(m.attempts).toBe(1);
    expect(m.next_retry_at).toBeTruthy();
    // First backoff is 5 min from `now`.
    expect(m.next_retry_at!.getTime()).toBe(now.getTime() + 5 * 60_000);
  });

  it('marks terminal (no retry) after MAX_ATTEMPTS failures', async () => {
    store.messages.push({
      id: 'm4', tenant_id: 't1', thread_id: 'thread-1', recipient_user_id: 'user-1',
      subject: 'X', body: 'y', status: 'FAILED', attempts: 2,  // one more = terminal
      metadata: null,
      next_retry_at: new Date('2026-05-16T00:00:00Z'),  // past, so eligible
    });
    providerSend.mockResolvedValueOnce({ providerId: '', status: 'FAILED', error: 'still broken' });

    const r = await dispatchCommsOutbox();
    expect(r.failed).toBe(1);
    expect(r.terminal).toBe(1);
    expect(store.messages[0]!.next_retry_at).toBeNull();
  });

  it('marks no-deliverable-address as terminal FAILED', async () => {
    store.messages.push({
      id: 'm5', tenant_id: 't1', thread_id: 'thread-1', recipient_user_id: null,
      subject: 'X', body: 'y', status: 'QUEUED', attempts: 0, metadata: null,
    });

    const r = await dispatchCommsOutbox();
    expect(r.failed).toBe(1);
    expect(r.terminal).toBe(1);
    expect(providerSend).not.toHaveBeenCalled();
  });

  it('skips IN_APP messages (caller already wrote them as SENT)', async () => {
    store.threads.push({ id: 'thread-app', channel: 'IN_APP' });
    store.messages.push({
      id: 'm6', tenant_id: 't1', thread_id: 'thread-app', recipient_user_id: 'user-1',
      subject: 'X', body: 'y', status: 'QUEUED', attempts: 0, metadata: null,
    });

    const r = await dispatchCommsOutbox();
    expect(r.sent).toBe(1);
    expect(providerSend).not.toHaveBeenCalled();
    expect(store.messages[0]!.status).toBe('SENT');
    // Clean up for other tests.
    store.threads.pop();
  });
});
