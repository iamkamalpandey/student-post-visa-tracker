// SVT-V2-CRM-MIRROR-2026-06 — coverage for the V2 MIS → crm_* mirror ingest.
//
// Two layers:
//   1. Pure mapping (leadCourseStateEnum / oneOf) — the funnel-state derivation
//      whose "ambiguous → null" rule directly gates post-visa fee seeding, so a
//      mis-map is a money-correctness bug.
//   2. ingestForTenant orchestration — FK resolution across the topological
//      upsert, DSAR-erased-lead skip (+ child freeze), per-row failure isolation,
//      and the post-visa fee-seed gate. fetchV2Crm + the prisma client are
//      mocked; one shared mock client backs both `prisma` and each tx.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('V2_INGEST_DEFAULT_CURRENCY', 'NPR');

// ── Shared mock prisma client (also used as each tx) ────────────────────────
type Upsert = ReturnType<typeof vi.fn>;
function makeUpsert(idPrefix: string): Upsert {
  let n = 0;
  return vi.fn(async () => ({ id: `${idPrefix}-${++n}` }));
}

const erasedLeadV2Ids: number[] = [];
const mock: Record<string, unknown> = {
  crmCountry: { upsert: makeUpsert('country') },
  crmInstitution: { upsert: makeUpsert('inst') },
  crmCourse: { upsert: makeUpsert('course') },
  crmLead: {
    upsert: makeUpsert('lead'),
    findMany: vi.fn(async () => erasedLeadV2Ids.map((v) => ({ v2_lead_id: v }))),
  },
  crmApplication: { upsert: makeUpsert('app') },
  crmLeadCourse: { upsert: makeUpsert('lc') },
  crmLeadCourseHistory: { upsert: makeUpsert('hist') },
  crmPayment: { upsert: makeUpsert('pay') },
  crmRemark: { upsert: makeUpsert('rem') },
  crmFollowUp: { upsert: makeUpsert('fu') },
  crmCallHistory: { upsert: makeUpsert('call') },
  crmVisit: { upsert: makeUpsert('visit') },
  crmAssignment: { upsert: makeUpsert('asg') },
  crmQualification: { upsert: makeUpsert('qual') },
  crmLanguageTest: { upsert: makeUpsert('lt') },
  crmGuardian: { upsert: makeUpsert('guard') },
  crmLeadFee: { createMany: vi.fn(async () => ({ count: 1 })) },
  $executeRaw: vi.fn(async () => 0),
  $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(mock)),
};

vi.mock('../src/config/db.js', () => ({ prisma: mock, disconnectDb: async () => undefined }));

// fetchV2Crm returns the full upstream dump; the test overrides per case.
const fetchV2CrmMock = vi.fn();
vi.mock('../src/integrations/v2-mis/queries.js', () => ({ fetchV2Crm: fetchV2CrmMock }));

const { ingestForTenant, leadCourseStateEnum, oneOf } = await import('../src/jobs/v2Ingest.js');

// A complete-but-empty dump; spread overrides on top.
function makeDump(overrides: Record<string, unknown[]> = {}): Record<string, unknown[]> {
  const keys = [
    'countries', 'institutions', 'courses', 'leads', 'applications', 'leadCourses',
    'history', 'payments', 'remarks', 'followUps', 'calls', 'visits', 'assignments',
    'qualifications', 'languageTests', 'guardians',
  ];
  const base: Record<string, unknown[]> = {};
  for (const k of keys) base[k] = [];
  return { ...base, ...overrides };
}

const TENANT = 'tenant-1';

beforeEach(() => {
  erasedLeadV2Ids.length = 0;
  for (const v of Object.values(mock)) {
    if (v && typeof v === 'object') {
      for (const fn of Object.values(v as Record<string, unknown>)) {
        if (typeof fn === 'function' && 'mockClear' in (fn as object)) (fn as ReturnType<typeof vi.fn>).mockClear();
      }
    }
  }
  (mock.$transaction as ReturnType<typeof vi.fn>).mockClear();
  (mock.crmLeadFee as { createMany: ReturnType<typeof vi.fn> }).createMany.mockClear();
  // Restore the default happy upsert behaviour (a test may override to throw).
  (mock.crmCountry as { upsert: Upsert }).upsert = makeUpsert('country');
});

// ─────────────────────────────────────────────────────────────────────────
describe('leadCourseStateEnum — funnel state derivation', () => {
  it('prefers the typed stateV2 enum when valid', () => {
    expect(leadCourseStateEnum('visa_accepted', 'anything')).toBe('visa_accepted');
    expect(leadCourseStateEnum('offer_accepted', null)).toBe('offer_accepted');
  });

  it('maps unambiguous legacy free-text (case / whitespace insensitive)', () => {
    expect(leadCourseStateEnum(null, 'Visa Accepted')).toBe('visa_accepted');
    expect(leadCourseStateEnum(null, 'visa   granted')).toBe('visa_accepted');
    expect(leadCourseStateEnum(null, 'VISA REFUSED')).toBe('visa_refused');
    expect(leadCourseStateEnum(null, 'Unconditional Offer')).toBe('offer_received_unconditional');
    expect(leadCourseStateEnum(undefined, 'document collection')).toBe('documents_collection');
  });

  it('returns null for AMBIGUOUS legacy values (never mis-stage finance)', () => {
    for (const ambiguous of ['draft', 'applied', 'accepted', 'rejected', 'GS Rejected', 'Offer Withdrawn', '']) {
      expect(leadCourseStateEnum(null, ambiguous), ambiguous).toBeNull();
    }
  });

  it('returns null when both inputs are null/undefined', () => {
    expect(leadCourseStateEnum(null, null)).toBeNull();
    expect(leadCourseStateEnum(undefined, undefined)).toBeNull();
  });

  it('ignores an out-of-enum stateV2 and falls back to legacy', () => {
    expect(leadCourseStateEnum('not_a_real_state', 'Visa Accepted')).toBe('visa_accepted');
    expect(leadCourseStateEnum('not_a_real_state', 'mystery')).toBeNull();
  });
});

describe('oneOf — enum guard', () => {
  const allowed = ['LOW', 'NORMAL', 'HIGH', 'VIP'] as const;
  it('returns the value when in the allowed set', () => {
    expect(oneOf('HIGH', allowed)).toBe('HIGH');
  });
  it('returns null when outside the set or nullish', () => {
    expect(oneOf('URGENT', allowed)).toBeNull();
    expect(oneOf(null, allowed)).toBeNull();
    expect(oneOf(undefined, allowed)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('ingestForTenant — orchestration', () => {
  it('resolves the FK chain country→institution→course→lead and counts upserts', async () => {
    fetchV2CrmMock.mockResolvedValue(
      makeDump({
        countries: [{ id: 1, name: 'Nepal', signature: 'NP', currency_code: 'NPR' }],
        institutions: [{ id: 10, name: 'Uni', countryId: 1, isActive: true }],
        courses: [{ id: 100, name: 'CS', institutionId: 10, feeAmount: 1000, feeCurrency: 'NPR' }],
        leads: [{ id: 1000, first_name: 'Maya', last_name: 'Patel' }],
      }),
    );
    const r = await ingestForTenant(TENANT);
    // 1 country + 1 institution + 1 course + 1 lead all upserted.
    expect(r.rowsProcessed).toBe(4);
    expect(r.rowsFailed).toBe(0);
    expect(r.studentsUpserted).toBe(1);
    // The course upsert received the resolved institution FK (not just the v2 id).
    const courseArgs = (mock.crmCourse as { upsert: ReturnType<typeof vi.fn> }).upsert.mock.calls[0][0];
    expect(courseArgs.create.institution_id).toBe('inst-1');
  });

  it('skips DSAR-erased leads and freezes their children', async () => {
    erasedLeadV2Ids.push(1000); // lead 1000 was erased
    fetchV2CrmMock.mockResolvedValue(
      makeDump({
        leads: [{ id: 1000, first_name: 'Erased' }],
        // a remark belonging to the erased lead → cannot resolve FK → rowsFailed
        remarks: [{ id: 7, leadId: 1000, content: 'note' }],
      }),
    );
    const r = await ingestForTenant(TENANT);
    expect((mock.crmLead as { upsert: ReturnType<typeof vi.fn> }).upsert).not.toHaveBeenCalled();
    expect(r.studentsUpserted).toBe(0);
    // The orphaned child (remark) is counted as failed, not silently dropped.
    expect(r.rowsFailed).toBeGreaterThanOrEqual(1);
    expect((mock.crmRemark as { upsert: ReturnType<typeof vi.fn> }).upsert).not.toHaveBeenCalled();
  });

  it('seeds a post-visa fee ONLY for a visa_accepted lead-course with a start date + course fee', async () => {
    fetchV2CrmMock.mockResolvedValue(
      makeDump({
        institutions: [{ id: 10, name: 'Uni', countryId: 1, isActive: true }],
        courses: [{ id: 100, name: 'CS', institutionId: 10, feeAmount: 5000, feeCurrency: 'NPR' }],
        leads: [{ id: 1000, first_name: 'Maya' }],
        leadCourses: [
          // visa_accepted + startDate → seeds
          { leadId: 1000, courseId: 100, state: 'Visa Accepted', stateV2: 'visa_accepted', startDate: new Date('2026-09-01') },
        ],
      }),
    );
    const r = await ingestForTenant(TENANT);
    expect((mock.crmLeadFee as { createMany: ReturnType<typeof vi.fn> }).createMany).toHaveBeenCalledTimes(1);
    expect(r.feesSeeded).toBe(1);
  });

  it('does NOT seed a fee for a visa_accepted lead-course missing a start date', async () => {
    fetchV2CrmMock.mockResolvedValue(
      makeDump({
        courses: [{ id: 100, name: 'CS', feeAmount: 5000, feeCurrency: 'NPR' }],
        leads: [{ id: 1000, first_name: 'Maya' }],
        leadCourses: [
          { leadId: 1000, courseId: 100, state: 'Visa Accepted', stateV2: 'visa_accepted', startDate: null },
        ],
      }),
    );
    const r = await ingestForTenant(TENANT);
    expect((mock.crmLeadFee as { createMany: ReturnType<typeof vi.fn> }).createMany).not.toHaveBeenCalled();
    expect(r.feesSeeded).toBe(0);
  });

  it('isolates a per-row failure: one bad upsert increments rowsFailed, the batch continues', async () => {
    // First country upsert throws, second succeeds → 1 failed, 1 processed.
    let call = 0;
    (mock.crmCountry as { upsert: ReturnType<typeof vi.fn> }).upsert = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error('db blip');
      return { id: 'country-ok' };
    });
    fetchV2CrmMock.mockResolvedValue(
      makeDump({
        countries: [
          { id: 1, name: 'Bad', signature: 'X', currency_code: 'NPR' },
          { id: 2, name: 'Good', signature: 'Y', currency_code: 'NPR' },
        ],
      }),
    );
    const r = await ingestForTenant(TENANT);
    expect(r.rowsFailed).toBe(1);
    expect(r.rowsProcessed).toBe(1);
  });
});
