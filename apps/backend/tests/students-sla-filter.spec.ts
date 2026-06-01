// SVT-WAVE39-STUDENT-SLA-FILTER-2026-05 — `sla_breached=true` on /students.
//
// The service translates the boolean into per-stage thresholds: students whose
// `stage_entered_at` is older than `now - stage.sla_hours` AND whose status
// isn't terminal. Tests verify: empty tenant returns []; the filter composes
// with `search`; explicit `status` is respected.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');

type Stage = { id: string; tenant_id: string; sla_hours: number | null; show_on_dashboard: boolean };
type Student = {
  id: string; tenant_id: string;
  student_code: string; given_name: string; family_name: string;
  current_stage_id: string; stage_entered_at: Date;
  status: string; deleted_at: Date | null;
  created_at: Date;
  current_stage?: unknown; assigned_to?: unknown;
};

const TENANT = '11111111-1111-7111-8111-111111111111';
const store = { stages: [] as Stage[], students: [] as Student[] };

vi.mock('../src/config/db.js', () => {
  const prisma = {
    lifecycleStage: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return store.stages.filter((s) => {
          if (s.tenant_id !== where['tenant_id']) return false;
          const sla = where['sla_hours'] as { not: null } | undefined;
          if (sla && sla.not === null && s.sla_hours == null) return false;
          if ('show_on_dashboard' in where && s.show_on_dashboard !== where['show_on_dashboard']) return false;
          return true;
        });
      }),
    },
    student: {
      findMany: vi.fn(async ({ where, take }: { where: Record<string, unknown>; take?: number }) => {
        return filterStudents(where, take);
      }),
      count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return filterStudents(where).length;
      }),
    },
  };
  return { prisma, disconnectDb: async () => undefined };
});

function filterStudents(where: Record<string, unknown>, take?: number): Student[] {
  let rows = store.students.filter((s) => {
    if (s.tenant_id !== where['tenant_id']) return false;
    if (where['deleted_at'] === null && s.deleted_at != null) return false;
    if (where['id'] && s.id !== where['id']) return false;
    const status = where['status'];
    if (typeof status === 'string' && s.status !== status) return false;
    if (status && typeof status === 'object' && 'notIn' in (status as object)) {
      if ((status as { notIn: string[] }).notIn.includes(s.status)) return false;
    }
    // SLA OR + search OR get folded into where.AND[].OR. We just walk both.
    const andList = where['AND'];
    if (Array.isArray(andList)) {
      for (const clause of andList as Array<Record<string, unknown>>) {
        const ors = clause['OR'];
        if (!Array.isArray(ors)) continue;
        const passes = (ors as Array<Record<string, unknown>>).some((or) => {
          // Empty/blind OR-element: skip — the production code never emits one.
          const fieldKeys = Object.keys(or);
          if (fieldKeys.length === 0) return false;
          for (const key of fieldKeys) {
            const cond = or[key];
            if (key === 'current_stage_id') {
              if (cond !== s.current_stage_id) return false;
            } else if (key === 'stage_entered_at') {
              const lt = (cond as { lt?: Date }).lt;
              if (lt && !(s.stage_entered_at < lt)) return false;
            } else if (key === 'family_name' || key === 'given_name' || key === 'student_code') {
              const needle = (cond as { contains?: string }).contains;
              const hay = (s as unknown as Record<string, string>)[key];
              if (needle && (!hay || !hay.toLowerCase().includes(needle.toLowerCase()))) return false;
            }
          }
          return true;
        });
        if (!passes) return false;
      }
    }
    return true;
  });
  rows = rows.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
  return take ? rows.slice(0, take) : rows;
}

const { prisma } = await import('../src/config/db.js');
const { list } = await import('../src/modules/students/students.service.js');

const HOUR_MS = 60 * 60 * 1000;

beforeEach(() => {
  store.stages.length = 0;
  store.students.length = 0;
});

function seedStage(opts: Partial<Stage> = {}): Stage {
  const s: Stage = {
    id: `stage-${store.stages.length + 1}`,
    tenant_id: TENANT,
    sla_hours: 48,
    show_on_dashboard: true,
    ...opts,
  };
  store.stages.push(s);
  return s;
}

function seedStudent(opts: Partial<Student> & { current_stage_id: string }): Student {
  const s: Student = {
    id: `student-${store.students.length + 1}`,
    tenant_id: TENANT,
    student_code: `SPV-2026-00${store.students.length + 1}`,
    given_name: 'Maya', family_name: 'Patel',
    stage_entered_at: new Date(Date.now() - 24 * HOUR_MS),
    status: 'ACTIVE', deleted_at: null, created_at: new Date(),
    ...opts,
  };
  store.students.push(s);
  return s;
}

describe('students.list — sla_breached filter', () => {
  it('returns empty set with no SLA stages configured', async () => {
    seedStudent({ current_stage_id: 'stage-noop' });
    const out = await list(
      { db: prisma as never, tenantId: TENANT },
      { limit: 50, sla_breached: true } as never,
    );
    expect(out.data).toEqual([]);
    expect(out.total).toBe(0);
  });

  it('returns only students breached past stage SLA, excluding terminal status', async () => {
    const stage = seedStage({ sla_hours: 48 });
    // 100h in stage — breached
    seedStudent({ current_stage_id: stage.id, stage_entered_at: new Date(Date.now() - 100 * HOUR_MS), family_name: 'Breach' });
    // 24h in stage — not breached
    seedStudent({ current_stage_id: stage.id, stage_entered_at: new Date(Date.now() - 24 * HOUR_MS), family_name: 'Ok' });
    // Withdrawn — excluded even though over SLA
    seedStudent({ current_stage_id: stage.id, stage_entered_at: new Date(Date.now() - 200 * HOUR_MS), status: 'WITHDRAWN', family_name: 'Gone' });
    const out = await list(
      { db: prisma as never, tenantId: TENANT },
      { limit: 50, sla_breached: true } as never,
    );
    expect(out.data).toHaveLength(1);
    expect((out.data[0] as { family_name: string }).family_name).toBe('Breach');
  });

  it('composes with `search` (intersection, not union)', async () => {
    const stage = seedStage({ sla_hours: 24 });
    seedStudent({ current_stage_id: stage.id, stage_entered_at: new Date(Date.now() - 100 * HOUR_MS), family_name: 'Carter' });
    seedStudent({ current_stage_id: stage.id, stage_entered_at: new Date(Date.now() - 100 * HOUR_MS), family_name: 'Patel' });
    const out = await list(
      { db: prisma as never, tenantId: TENANT },
      { limit: 50, sla_breached: true, search: 'carter' } as never,
    );
    expect(out.data).toHaveLength(1);
    expect((out.data[0] as { family_name: string }).family_name).toBe('Carter');
  });

  it('respects explicit q.status (does not override with notIn)', async () => {
    const stage = seedStage({ sla_hours: 24 });
    // Both rows past SLA; one ACTIVE one ON_HOLD.
    seedStudent({ current_stage_id: stage.id, stage_entered_at: new Date(Date.now() - 100 * HOUR_MS), status: 'ACTIVE', family_name: 'A' });
    seedStudent({ current_stage_id: stage.id, stage_entered_at: new Date(Date.now() - 100 * HOUR_MS), status: 'ON_HOLD', family_name: 'B' });
    const out = await list(
      { db: prisma as never, tenantId: TENANT },
      { limit: 50, sla_breached: true, status: 'ON_HOLD' } as never,
    );
    expect(out.data).toHaveLength(1);
    expect((out.data[0] as { status: string }).status).toBe('ON_HOLD');
  });

  it('ignores hidden-from-dashboard SLA stages', async () => {
    const hidden = seedStage({ sla_hours: 24, show_on_dashboard: false });
    seedStudent({ current_stage_id: hidden.id, stage_entered_at: new Date(Date.now() - 100 * HOUR_MS) });
    const out = await list(
      { db: prisma as never, tenantId: TENANT },
      { limit: 50, sla_breached: true } as never,
    );
    expect(out.data).toEqual([]);
  });
});
