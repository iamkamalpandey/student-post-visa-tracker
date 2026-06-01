// SVT-WAVE16-TEMPLATE-2026-05 — createFromTemplate service: template lookup,
// context build, interpolation, delegated create.

import { beforeEach, describe, expect, it, vi } from 'vitest';

type TemplateRow = {
  id: string;
  tenant_id: string;
  channel: 'EMAIL' | 'SMS' | 'WHATSAPP' | 'IN_APP';
  subject: string | null;
  body_md: string;
  is_active: boolean;
};
type StudentRow = {
  id: string;
  tenant_id: string;
  given_name: string;
  family_name: string;
  middle_name: string | null;
  preferred_name: string | null;
  email_primary: string | null;
  phone_primary_e164: string | null;
  student_code: string;
  nationality_code: string;
  deleted_at: Date | null;
};
type EnrollmentRow = {
  id: string;
  tenant_id: string;
  student_id: string;
  status: string;
  start_date: Date | null;
  expected_end_date: Date | null;
  institution: { id: string; display_name: string } | null;
  program: { id: string; name: string; level: string } | null;
  deleted_at: Date | null;
};
type MessageRow = {
  id: string;
  tenant_id: string;
  thread_id: string;
  body: string;
  template_id: string | null;
  metadata: Record<string, unknown> | null;
};

const store = {
  templates: [] as TemplateRow[],
  students: [] as StudentRow[],
  enrollments: [] as EnrollmentRow[],
  threads: [] as { id: string; tenant_id: string; student_id: string; channel: string }[],
  messages: [] as MessageRow[],
};

let nid = 1;
const uid = (p: string) => `${p}-${nid++}`;

vi.mock('../src/config/db.js', () => {
  const prisma = {
    messageTemplate: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        store.templates.find((t) =>
          t.id === where['id'] && t.tenant_id === where['tenant_id'] && t.is_active === where['is_active'],
        ) ?? null,
      ),
    },
    student: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        store.students.find((s) =>
          s.id === where['id'] && s.tenant_id === where['tenant_id'] && s.deleted_at === where['deleted_at'],
        ) ?? null,
      ),
    },
    enrollment: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        store.enrollments.find((e) =>
          e.id === where['id'] && e.tenant_id === where['tenant_id'] &&
          e.student_id === where['student_id'] && e.deleted_at === where['deleted_at'],
        ) ?? null,
      ),
    },
    commsThread: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        store.threads.find((t) =>
          t.tenant_id === where['tenant_id'] && t.student_id === where['student_id'] && t.channel === where['channel'],
        ) ?? null,
      ),
      create: vi.fn(async ({ data }: { data: { tenant_id: string; student_id: string; channel: string } }) => {
        const row = { id: uid('t'), ...data };
        store.threads.push(row);
        return row;
      }),
    },
    commsMessage: {
      create: vi.fn(async ({ data }: { data: Omit<MessageRow, 'id'> }) => {
        const row = { id: uid('m'), ...data };
        store.messages.push(row);
        return row;
      }),
      update: vi.fn(async () => ({})),
    },
  };
  return { prisma, disconnectDb: async () => undefined };
});

vi.mock('../src/shared/audit.js', () => ({ writeAudit: vi.fn(async () => undefined) }));

const { messageService } = await import('../src/modules/comms/service.js');

function resetStore() {
  store.templates.length = 0;
  store.students.length = 0;
  store.enrollments.length = 0;
  store.threads.length = 0;
  store.messages.length = 0;
  nid = 1;
}

const TENANT = 'tenant-1';
const USER = 'user-1';

function seedStudent(): StudentRow {
  const s: StudentRow = {
    id: uid('s'), tenant_id: TENANT, given_name: 'Maya', family_name: 'Patel',
    middle_name: null, preferred_name: null, email_primary: 'maya@example.com',
    phone_primary_e164: null, student_code: 'SPV-2026-000001', nationality_code: 'IN',
    deleted_at: null,
  };
  store.students.push(s);
  return s;
}

function seedTemplate(opts: Partial<TemplateRow> = {}): TemplateRow {
  const t: TemplateRow = {
    id: uid('tpl'), tenant_id: TENANT, channel: 'EMAIL', is_active: true,
    subject: 'Welcome {{ student.given_name }}',
    body_md: 'Hi {{ student.given_name }} {{ student.family_name }}, code {{ student.student_code }}, today {{ today }}.',
    ...opts,
  };
  store.templates.push(t);
  return t;
}

describe('messageService.createFromTemplate', () => {
  beforeEach(() => resetStore());

  it('renders subject + body with student context + today', async () => {
    const s = seedStudent();
    const t = seedTemplate();

    const result = await messageService.createFromTemplate(
      { user: { tid: TENANT, sub: USER } },
      s.id,
      { template_id: t.id },
    );
    expect(result.body).toContain('Hi Maya Patel, code SPV-2026-000001, today ');
    expect(result.template_id).toBe(t.id);
    expect(store.messages).toHaveLength(1);
  });

  it('honors caller `vars` overrides over auto-context', async () => {
    const s = seedStudent();
    const t = seedTemplate({
      subject: null,
      body_md: 'Hello {{ student.given_name }}, custom var {{ topic }}.',
    });
    const result = await messageService.createFromTemplate(
      { user: { tid: TENANT, sub: USER } },
      s.id,
      { template_id: t.id, vars: { topic: 'visa interview' } },
    );
    expect(result.body).toBe('Hello Maya, custom var visa interview.');
  });

  it('throws NotFound for missing template', async () => {
    const s = seedStudent();
    await expect(
      messageService.createFromTemplate(
        { user: { tid: TENANT, sub: USER } },
        s.id,
        { template_id: 'no-such-template' },
      ),
    ).rejects.toThrowError(/Template not found/);
  });

  it('throws NotFound for missing student', async () => {
    const t = seedTemplate();
    await expect(
      messageService.createFromTemplate(
        { user: { tid: TENANT, sub: USER } },
        'no-such-student',
        { template_id: t.id },
      ),
    ).rejects.toThrowError(/Student not found/);
  });

  it('renders empty for missing placeholders (never leaks {{x}})', async () => {
    const s = seedStudent();
    const t = seedTemplate({ subject: null, body_md: 'X{{ unknown.deep.path }}Y' });
    const result = await messageService.createFromTemplate(
      { user: { tid: TENANT, sub: USER } },
      s.id,
      { template_id: t.id },
    );
    expect(result.body).toBe('XY');
  });
});

// SVT-WAVE18-PREVIEW-2026-05 — dry-render variant; no DB write.
describe('messageService.previewFromTemplate', () => {
  beforeEach(() => resetStore());

  it('returns rendered subject + body + placeholder inventory + missing list', async () => {
    const s = seedStudent();
    const t = seedTemplate({
      subject: 'Hi {{ student.given_name }}',
      body_md: 'Code: {{ student.student_code }}. Unset: {{ enrollment.status }}.',
    });
    const r = await messageService.previewFromTemplate(
      { user: { tid: TENANT, sub: USER } },
      s.id,
      { template_id: t.id },
    );
    expect(r.subject).toBe('Hi Maya');
    expect(r.body).toBe('Code: SPV-2026-000001. Unset: .');
    expect(r.placeholders.sort()).toEqual([
      'enrollment.status', 'student.given_name', 'student.student_code',
    ]);
    expect(r.missing).toEqual(['enrollment.status']);
    expect(r.channel).toBe('EMAIL');
    // Crucial — no DB write happened.
    expect(store.messages).toHaveLength(0);
  });

  it('throws when template is missing', async () => {
    const s = seedStudent();
    await expect(
      messageService.previewFromTemplate(
        { user: { tid: TENANT, sub: USER } },
        s.id,
        { template_id: 'nope' },
      ),
    ).rejects.toThrowError(/Template not found/);
  });
});
