// SVT-EXPORT-FILTER-2026-08 — the students list and the students CSV export
// must apply the SAME predicate.
//
// The bug this pins: the export pipeline whitelisted a single scalar (`status`)
// and silently discarded every other filter. A counsellor who narrowed the
// students list to twelve SLA-breached records and clicked "Export CSV"
// received a CSV containing EVERY student in the tenant — no error, no warning,
// and a UI comment promising the file was "an exact representation of what the
// user sees on screen". Exporting far more subject data than the operator asked
// for is a disclosure problem, not merely a wrong row count.
//
// The fix was to extract one `buildStudentListWhere` used by both paths. These
// tests assert each filter actually reaches the WHERE, so the two cannot drift
// apart again.

import { describe, it, expect, vi } from 'vitest';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3000');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

const { buildStudentListWhere } = await import('../src/modules/students/students.service.js');

const TENANT = '11111111-1111-7111-8111-111111111111';

/** Minimal db stub — only `lifecycleStage.findMany` is consulted, by sla_breached. */
function dbWithStages(stages: Array<{ id: string; sla_hours: number }>) {
  return {
    lifecycleStage: { findMany: async () => stages },
  } as never;
}

/** Flatten the AND array so assertions don't depend on clause ordering. */
function andClauses(where: Record<string, unknown>): Array<Record<string, unknown>> {
  const and = where['AND'];
  if (!and) return [];
  return (Array.isArray(and) ? and : [and]) as Array<Record<string, unknown>>;
}

describe('buildStudentListWhere — tenant and soft-delete are never optional', () => {
  it('always pins tenant_id and excludes soft-deleted rows', async () => {
    const where = await buildStudentListWhere(dbWithStages([]), TENANT, {});
    expect(where.tenant_id).toBe(TENANT);
    // Soft-deleted subjects must never re-surface through the bulk pipeline —
    // that would defeat GDPR Art. 17 erasure and the retention crons.
    expect(where.deleted_at).toBeNull();
  });
});

describe('buildStudentListWhere — every list filter reaches the predicate', () => {
  it('applies stage_id', async () => {
    const where = await buildStudentListWhere(dbWithStages([]), TENANT, { stage_id: 'stage-1' });
    expect(where.current_stage_id).toBe('stage-1');
  });

  it('applies status', async () => {
    const where = await buildStudentListWhere(dbWithStages([]), TENANT, { status: 'ACTIVE' as never });
    expect(where.status).toBe('ACTIVE');
  });

  it('applies assigned_to_id (caseload scoping)', async () => {
    const where = await buildStudentListWhere(dbWithStages([]), TENANT, { assigned_to_id: 'user-1' });
    expect(where.assigned_to_id).toBe('user-1');
  });

  it('applies search across family name, given name and student code', async () => {
    // This is the filter whose loss was most visible: a counsellor searching
    // "Sharma" and exporting used to get the entire tenant.
    const where = await buildStudentListWhere(dbWithStages([]), TENANT, { search: '  Sharma  ' });
    const or = andClauses(where).find((c) => Array.isArray(c['OR']))?.['OR'] as
      | Array<Record<string, unknown>>
      | undefined;
    expect(or).toBeDefined();
    const fields = or!.map((c) => Object.keys(c)[0]).sort();
    expect(fields).toEqual(['family_name', 'given_name', 'student_code']);
    // Trimmed, and case-insensitive so the export matches what the screen showed.
    for (const clause of or!) {
      const spec = Object.values(clause)[0] as { contains: string; mode: string };
      expect(spec.contains).toBe('Sharma');
      expect(spec.mode).toBe('insensitive');
    }
  });

  it('applies an explicit id set so "export selected" exports only the ticked rows', async () => {
    const ids = ['a1', 'b2', 'c3'];
    const where = await buildStudentListWhere(dbWithStages([]), TENANT, { ids });
    expect(where.id).toEqual({ in: ids });
  });

  it('ignores an empty id list rather than matching nothing', async () => {
    const where = await buildStudentListWhere(dbWithStages([]), TENANT, { ids: [] });
    expect(where.id).toBeUndefined();
  });
});

describe('buildStudentListWhere — sla_breached', () => {
  it('expands to a per-stage threshold OR and defaults to ACTIVE', async () => {
    const where = await buildStudentListWhere(
      dbWithStages([
        { id: 'stage-a', sla_hours: 24 },
        { id: 'stage-b', sla_hours: 72 },
      ]),
      TENANT,
      { sla_breached: true },
    );
    const or = andClauses(where).find((c) => Array.isArray(c['OR']))?.['OR'] as
      | Array<Record<string, unknown>>
      | undefined;
    expect(or).toHaveLength(2);
    expect(or!.map((c) => c['current_stage_id'])).toEqual(['stage-a', 'stage-b']);
    // Only ACTIVE students have a running SLA clock; ON_HOLD / ON_LEAVE are
    // deliberate pauses and the terminal statuses are not breaches.
    expect(where.status).toBe('ACTIVE');
  });

  it('does not override an explicitly requested status', async () => {
    const where = await buildStudentListWhere(
      dbWithStages([{ id: 'stage-a', sla_hours: 24 }]),
      TENANT,
      { sla_breached: true, status: 'ON_HOLD' as never },
    );
    expect(where.status).toBe('ON_HOLD');
  });

  it('yields an empty set — without clobbering an id filter — when no stage has an SLA', async () => {
    // Regression guard: the original code assigned `where.id` directly here,
    // which would silently discard an "export selected" id list.
    const where = await buildStudentListWhere(dbWithStages([]), TENANT, {
      sla_breached: true,
      ids: ['keep-me'],
    });
    expect(where.id).toEqual({ in: ['keep-me'] });
    const sentinel = andClauses(where).find((c) => typeof c['id'] === 'string');
    expect(sentinel).toBeDefined();
  });
});

describe('buildStudentListWhere — filters compose rather than overwrite', () => {
  it('keeps both the SLA OR and the search OR when used together', async () => {
    // Prisma exposes a single `OR` slot, so two OR-bearing filters must each
    // live in their own AND entry or the last one silently wins.
    const where = await buildStudentListWhere(
      dbWithStages([{ id: 'stage-a', sla_hours: 24 }]),
      TENANT,
      { sla_breached: true, search: 'Gurung', stage_id: 'stage-a', status: 'ACTIVE' as never },
    );
    const orGroups = andClauses(where).filter((c) => Array.isArray(c['OR']));
    expect(orGroups).toHaveLength(2);
    expect(where.current_stage_id).toBe('stage-a');
    expect(where.status).toBe('ACTIVE');
  });
});
