// SVT-WAVE14-DIGEST-2026-05 — daily digest collapses per-user queued EMAIL
// rows into one summary, marking originals SENT with back-pointer metadata.

import { beforeEach, describe, expect, it, vi } from 'vitest';

type MsgRow = {
  id: string;
  tenant_id: string;
  recipient_user_id: string | null;
  status: string;
  subject: string | null;
  body: string;
  thread_id: string;
  created_at: Date;
  metadata: Record<string, unknown> | null;
  sent_at: Date | null;
};

type ThreadRow = { id: string; tenant_id: string; student_id: string | null; channel: string; subject: string | null };
type UserRow = {
  id: string;
  tenant_id: string;
  email: string;
  is_active: boolean;
  deleted_at: Date | null;
  notifications_email_enabled: boolean;
  notifications_digest: 'PER_EVENT' | 'DAILY' | 'OFF';
};

const store = {
  messages: [] as MsgRow[],
  threads: [] as ThreadRow[],
  users: [] as UserRow[],
};

let nextId = 1;
function uid(prefix: string): string { return `${prefix}-${nextId++}`; }

vi.mock('../src/config/db.js', () => {
  const prisma = {
    user: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return store.users.filter((u) =>
          u.deleted_at === null &&
          u.is_active === true &&
          u.notifications_digest === where['notifications_digest'] &&
          u.notifications_email_enabled === where['notifications_email_enabled'],
        );
      }),
    },
    commsMessage: {
      findMany: vi.fn(async ({ where, take }: { where: Record<string, unknown>; take?: number }) => {
        const rows = store.messages.filter((m) => {
          if (m.tenant_id !== where['tenant_id']) return false;
          if (m.recipient_user_id !== where['recipient_user_id']) return false;
          if (m.status !== where['status']) return false;
          // thread channel filter
          const threadFilter = (where['thread'] as { channel?: string } | undefined);
          if (threadFilter?.channel) {
            const t = store.threads.find((th) => th.id === m.thread_id);
            if (!t || t.channel !== threadFilter.channel) return false;
          }
          return true;
        }).sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
        return take ? rows.slice(0, take) : rows;
      }),
      create: vi.fn(async ({ data }: { data: Omit<MsgRow, 'id' | 'created_at' | 'sent_at' | 'metadata'> & { metadata?: Record<string, unknown> } }) => {
        const row: MsgRow = {
          ...data,
          id: uid('m'),
          created_at: new Date(),
          sent_at: null,
          metadata: data.metadata ?? null,
        };
        store.messages.push(row);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { id: { in: string[] }; status: string }; data: Record<string, unknown> }) => {
        const ids = new Set(where.id.in);
        let count = 0;
        for (const m of store.messages) {
          if (ids.has(m.id) && m.status === where.status) {
            for (const [k, v] of Object.entries(data)) (m as Record<string, unknown>)[k] = v as never;
            count += 1;
          }
        }
        return { count };
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
      create: vi.fn(async ({ data }: { data: Omit<ThreadRow, 'id'> }) => {
        const row: ThreadRow = { ...data, id: uid('t') };
        store.threads.push(row);
        return row;
      }),
    },
    $transaction: vi.fn(async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma)),
    $executeRaw: vi.fn(async () => 1),
  };
  return { prisma, disconnectDb: async () => undefined };
});

const { runCommsDigest } = await import('../src/jobs/commsDigest.js');

function resetStore() {
  store.messages.length = 0;
  store.threads.length = 0;
  store.users.length = 0;
  nextId = 1;
}

function seedUser(opts: Partial<UserRow> = {}): UserRow {
  const u: UserRow = {
    id: uid('u'), tenant_id: 'tenant-1', email: 'u@example.com',
    is_active: true, deleted_at: null,
    notifications_email_enabled: true, notifications_digest: 'DAILY',
    ...opts,
  };
  store.users.push(u);
  return u;
}

function seedEmailThread(tenantId = 'tenant-1'): ThreadRow {
  const t: ThreadRow = { id: uid('t'), tenant_id: tenantId, student_id: 'student-x', channel: 'EMAIL', subject: 'Reminders' };
  store.threads.push(t);
  return t;
}

function seedQueuedMsg(user: UserRow, thread: ThreadRow, subject: string): MsgRow {
  const row: MsgRow = {
    id: uid('m'), tenant_id: user.tenant_id, recipient_user_id: user.id,
    status: 'QUEUED', subject, body: subject, thread_id: thread.id,
    created_at: new Date(), metadata: null, sent_at: null,
  };
  store.messages.push(row);
  return row;
}

describe('runCommsDigest', () => {
  beforeEach(() => resetStore());

  it('collapses N queued EMAILs into 1 summary per DAILY user', async () => {
    const user = seedUser();
    const thread = seedEmailThread();
    seedQueuedMsg(user, thread, 'Visa expiry in 30 days');
    seedQueuedMsg(user, thread, 'Tuition due in 14 days');
    seedQueuedMsg(user, thread, 'Document expires in 60 days');

    const r = await runCommsDigest();

    expect(r.users_scanned).toBe(1);
    expect(r.users_with_events).toBe(1);
    expect(r.digests_created).toBe(1);
    expect(r.rows_collapsed).toBe(3);

    const summary = store.messages.find((m) => m.subject?.startsWith('[SPV] Daily digest'));
    expect(summary).toBeTruthy();
    expect(summary!.status).toBe('QUEUED');
    expect(summary!.body).toContain('3 updates since yesterday');
    expect(summary!.body).toContain('Visa expiry in 30 days');

    const originals = store.messages.filter((m) => m.subject === 'Visa expiry in 30 days' || m.subject === 'Tuition due in 14 days' || m.subject === 'Document expires in 60 days');
    expect(originals.every((m) => m.status === 'SENT')).toBe(true);
    expect(originals.every((m) => m.metadata?.['digested_into'] === summary!.id)).toBe(true);
  });

  it('skips users with no queued events', async () => {
    seedUser();
    const r = await runCommsDigest();
    expect(r.users_scanned).toBe(1);
    expect(r.users_with_events).toBe(0);
    expect(r.digests_created).toBe(0);
  });

  it('does not pick up PER_EVENT users', async () => {
    const u = seedUser({ notifications_digest: 'PER_EVENT' });
    const t = seedEmailThread();
    seedQueuedMsg(u, t, 'should not be digested');
    const r = await runCommsDigest();
    expect(r.users_scanned).toBe(0);
    expect(r.digests_created).toBe(0);
  });

  it('does not pick up email-disabled users', async () => {
    const u = seedUser({ notifications_email_enabled: false });
    const t = seedEmailThread();
    seedQueuedMsg(u, t, 'noop');
    const r = await runCommsDigest();
    expect(r.users_scanned).toBe(0);
  });
});
