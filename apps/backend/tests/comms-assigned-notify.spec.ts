// SVT-WAVE35-XTEAM-NOTIFY-2026-05 — bell ping when a counsellor sends on a
// student assigned to another user.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');

const TENANT = '11111111-1111-7111-8111-111111111111';
const ASSIGNEE = '22222222-2222-7222-8222-222222222222';
const SENDER = '33333333-3333-7333-8333-333333333333';
const STUDENT = '44444444-4444-7444-8444-444444444444';
const MSG = '55555555-5555-7555-8555-555555555555';
const THREAD = '66666666-6666-7666-8666-666666666666';

type Student = {
  id: string;
  tenant_id: string;
  student_code: string;
  given_name: string;
  family_name: string;
  assigned_to_id: string | null;
  deleted_at: Date | null;
};
type CommsThread = { id: string; tenant_id: string; student_id: string | null; channel: string; subject: string | null };
type CommsMessage = Record<string, unknown> & { id?: string };

const store = {
  students: [] as Student[],
  threads: [] as CommsThread[],
  messages: [] as CommsMessage[],
};

type User = {
  id: string; tenant_id: string;
  given_name: string; family_name: string;
  display_name: string | null;
};
const userStore: { users: User[] } = { users: [] };

vi.mock('../src/config/db.js', () => {
  const prisma = {
    student: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return store.students.find((s) =>
          s.id === where['id'] &&
          s.tenant_id === where['tenant_id'] &&
          (where['deleted_at'] === null ? s.deleted_at == null : true),
        ) ?? null;
      }),
    },
    user: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return userStore.users.find((u) =>
          u.id === where['id'] && u.tenant_id === where['tenant_id'],
        ) ?? null;
      }),
    },
    commsThread: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return store.threads.find((t) =>
          t.tenant_id === where['tenant_id'] &&
          t.student_id === (where['student_id'] ?? null) &&
          t.channel === where['channel'] &&
          (where['subject'] === undefined || t.subject === where['subject']),
        ) ?? null;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const t = { id: randomUUID(), ...data } as CommsThread;
        store.threads.push(t);
        return t;
      }),
    },
    commsMessage: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const m: CommsMessage = { id: randomUUID(), ...data };
        store.messages.push(m);
        return m;
      }),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
    $executeRaw: vi.fn(async () => 1),
  };
  return { prisma, disconnectDb: async () => undefined };
});

const { notifyAssignedCounsellorOnNewMessage } = await import('../src/modules/comms/service.js');

beforeEach(() => {
  store.students.length = 0;
  store.threads.length = 0;
  store.messages.length = 0;
  userStore.users.length = 0;
});

function seedUser(opts: Partial<User> & { id: string }): User {
  const u: User = {
    tenant_id: TENANT, given_name: 'Sarah', family_name: 'Khan',
    display_name: null,
    ...opts,
  };
  userStore.users.push(u);
  return u;
}

function seedStudent(opts: Partial<Student> = {}): Student {
  const s: Student = {
    id: STUDENT, tenant_id: TENANT, student_code: 'SPV-2026-000001',
    given_name: 'Maya', family_name: 'Patel',
    assigned_to_id: ASSIGNEE, deleted_at: null, ...opts,
  };
  store.students.push(s);
  return s;
}

describe('notifyAssignedCounsellorOnNewMessage', () => {
  it('writes IN_APP message to assignee when sender is different user', async () => {
    seedStudent();
    await notifyAssignedCounsellorOnNewMessage({
      tenantId: TENANT,
      studentId: STUDENT,
      senderUserId: SENDER,
      messageId: MSG,
      threadId: THREAD,
      channel: 'EMAIL',
      snippet: 'Hi Maya, please confirm…',
    });
    expect(store.messages).toHaveLength(1);
    const m = store.messages[0]!;
    expect(m['recipient_user_id']).toBe(ASSIGNEE);
    expect(m['direction']).toBe('OUTBOUND');
    expect(m['status']).toBe('SENT');
    const meta = m['metadata'] as Record<string, unknown>;
    expect(meta['source']).toBe('assigned_student_activity');
    expect(meta['href']).toBe(`/students/${STUDENT}?tab=records`);
    expect(meta['entity_id']).toBe(MSG);
    expect(meta['thread_id']).toBe(THREAD);
    expect(meta['channel']).toBe('EMAIL');
    // Thread reused / created with the expected subject.
    expect(store.threads).toHaveLength(1);
    expect(store.threads[0]!.subject).toBe('Assigned-student activity');
    expect(store.threads[0]!.student_id).toBeNull();
  });

  it('is a no-op when sender IS the assignee', async () => {
    seedStudent({ assigned_to_id: SENDER });
    await notifyAssignedCounsellorOnNewMessage({
      tenantId: TENANT,
      studentId: STUDENT,
      senderUserId: SENDER,
      messageId: MSG,
      threadId: THREAD,
      channel: 'EMAIL',
      snippet: 'self-message',
    });
    expect(store.messages).toHaveLength(0);
    expect(store.threads).toHaveLength(0);
  });

  it('is a no-op when the student has no assignee', async () => {
    seedStudent({ assigned_to_id: null });
    await notifyAssignedCounsellorOnNewMessage({
      tenantId: TENANT,
      studentId: STUDENT,
      senderUserId: SENDER,
      messageId: MSG,
      threadId: THREAD,
      channel: 'SMS',
      snippet: 'orphan',
    });
    expect(store.messages).toHaveLength(0);
  });

  it('is a no-op when the student is soft-deleted', async () => {
    seedStudent({ deleted_at: new Date() });
    await notifyAssignedCounsellorOnNewMessage({
      tenantId: TENANT,
      studentId: STUDENT,
      senderUserId: SENDER,
      messageId: MSG,
      threadId: THREAD,
      channel: 'EMAIL',
      snippet: 'gone',
    });
    expect(store.messages).toHaveLength(0);
  });

  it('is a no-op when sender is anonymous (no userId)', async () => {
    seedStudent();
    await notifyAssignedCounsellorOnNewMessage({
      tenantId: TENANT,
      studentId: STUDENT,
      senderUserId: null,
      messageId: MSG,
      threadId: THREAD,
      channel: 'EMAIL',
      snippet: 'system',
    });
    expect(store.messages).toHaveLength(0);
  });

  it('reuses the existing synthetic thread across multiple calls', async () => {
    seedStudent();
    await notifyAssignedCounsellorOnNewMessage({
      tenantId: TENANT, studentId: STUDENT, senderUserId: SENDER,
      messageId: 'a', threadId: 't', channel: 'EMAIL', snippet: 'first',
    });
    await notifyAssignedCounsellorOnNewMessage({
      tenantId: TENANT, studentId: STUDENT, senderUserId: SENDER,
      messageId: 'b', threadId: 't', channel: 'SMS', snippet: 'second',
    });
    expect(store.threads).toHaveLength(1); // synthetic thread reused
    expect(store.messages).toHaveLength(2);
  });

  it('truncates snippet at 120 chars (caller responsibility) but does not crash on empty', async () => {
    seedStudent();
    await notifyAssignedCounsellorOnNewMessage({
      tenantId: TENANT, studentId: STUDENT, senderUserId: SENDER,
      messageId: MSG, threadId: THREAD, channel: 'EMAIL', snippet: '',
    });
    expect(store.messages).toHaveLength(1);
    expect((store.messages[0]!['body'] as string).length).toBeGreaterThan(0);
  });

  // SVT-WAVE47-NOTIFY-SIGNATURE-2026-05
  it('prefixes title with sender display_name when user row resolves', async () => {
    seedStudent();
    seedUser({ id: SENDER, display_name: 'Sarah K.' });
    await notifyAssignedCounsellorOnNewMessage({
      tenantId: TENANT, studentId: STUDENT, senderUserId: SENDER,
      messageId: MSG, threadId: THREAD, channel: 'EMAIL', snippet: 'hi',
    });
    expect(store.messages).toHaveLength(1);
    const meta = store.messages[0]!['metadata'] as Record<string, unknown>;
    expect(meta['sender_user_id']).toBe(SENDER);
    expect(meta['sender_label']).toBe('Sarah K.');
    expect((meta['title'] as string)).toMatch(/^EMAIL from Sarah K\. on /);
  });

  it('falls back to given+family when display_name is null', async () => {
    seedStudent();
    seedUser({ id: SENDER, given_name: 'Sarah', family_name: 'Khan', display_name: null });
    await notifyAssignedCounsellorOnNewMessage({
      tenantId: TENANT, studentId: STUDENT, senderUserId: SENDER,
      messageId: MSG, threadId: THREAD, channel: 'SMS', snippet: '',
    });
    const meta = store.messages[0]!['metadata'] as Record<string, unknown>;
    expect(meta['sender_label']).toBe('Sarah Khan');
    expect((meta['title'] as string)).toMatch(/^SMS from Sarah Khan on /);
  });

  it('keeps the legacy bare title when the sender row cannot be resolved', async () => {
    seedStudent();
    // No seedUser → user.findFirst returns null.
    await notifyAssignedCounsellorOnNewMessage({
      tenantId: TENANT, studentId: STUDENT, senderUserId: SENDER,
      messageId: MSG, threadId: THREAD, channel: 'EMAIL', snippet: '',
    });
    const meta = store.messages[0]!['metadata'] as Record<string, unknown>;
    expect(meta['sender_label']).toBeNull();
    expect((meta['title'] as string)).toMatch(/^EMAIL message on /);
  });
});
