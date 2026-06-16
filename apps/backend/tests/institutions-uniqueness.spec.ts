// SVT-DQ-2026-06 — radio-button semantics for the institution's primary contact
// and main campus: setting one demotes the prior. Service-level (mock db passed
// via ctx; audit stubbed). The DB partial unique index is the race safety net.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/shared/audit.js', () => ({ writeAudit: vi.fn(async () => undefined) }));

const { createContact, createCampus, updateCampus } = await import(
  '../src/modules/institutions/institutions.service.js'
);

const INST = 'inst-1';

function makeDb() {
  return {
    institution: { findFirst: vi.fn(async () => ({ id: INST })) },
    institutionContact: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      create: vi.fn(async (a: { data: Record<string, unknown> }) => ({ id: 'c1', ...a.data })),
    },
    campus: {
      findFirst: vi.fn(async () => ({ id: 'cmp1', institution_id: INST })),
      updateMany: vi.fn(async () => ({ count: 1 })),
      create: vi.fn(async (a: { data: Record<string, unknown> }) => ({ id: 'cmp1', ...a.data })),
      update: vi.fn(async () => ({ id: 'cmp1' })),
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx = (db: any) => ({ db, tenantId: 't1', actorId: 'u1' }) as never;

let db: ReturnType<typeof makeDb>;
beforeEach(() => {
  db = makeDb();
});

describe('institution primary-contact / main-campus uniqueness', () => {
  it('demotes the prior primary contact when creating a primary one', async () => {
    await createContact(ctx(db), INST, { full_name: 'Jane', is_primary: true } as never);
    expect(db.institutionContact.updateMany).toHaveBeenCalledTimes(1);
    expect(db.institutionContact.updateMany.mock.calls[0]![0]).toMatchObject({
      where: { institution_id: INST, is_primary: true },
      data: { is_primary: false },
    });
  });

  it('does not demote when the new contact is not primary', async () => {
    await createContact(ctx(db), INST, { full_name: 'Jane', is_primary: false } as never);
    expect(db.institutionContact.updateMany).not.toHaveBeenCalled();
  });

  it('demotes the prior main campus when creating a main one', async () => {
    await createCampus(ctx(db), INST, { name: 'Main', is_main: true } as never);
    expect(db.campus.updateMany).toHaveBeenCalledTimes(1);
    expect(db.campus.updateMany.mock.calls[0]![0]).toMatchObject({
      where: { institution_id: INST, is_main: true },
      data: { is_main: false },
    });
  });

  it('demotes the OTHER main campuses when promoting one via update', async () => {
    await updateCampus(ctx(db), 'cmp1', { is_main: true } as never);
    expect(db.campus.updateMany).toHaveBeenCalledTimes(1);
    expect(db.campus.updateMany.mock.calls[0]![0]).toMatchObject({
      where: { institution_id: INST, is_main: true, id: { not: 'cmp1' } },
      data: { is_main: false },
    });
  });
});
