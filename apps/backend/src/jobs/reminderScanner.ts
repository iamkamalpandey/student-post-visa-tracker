// Reminder scanner — produces auto-generated Reminder rows from the source
// entities the dashboard cares about (intakes, finance, visas, passports,
// insurance, documents). Designed to be safe to re-run on the same day:
// every insert hits the @@unique constraint on
//   (tenant_id, source_entity_type, source_entity_id, scheduled_for)
// and bulk createMany({ skipDuplicates: true }) means a duplicate is a no-op.
//
// SVT-PERF-REMINDER-SCANNER-BATCH-2026-05 — Previously the scanner ran one
// `prisma.$transaction` per candidate reminder (~3000+ round-trips per
// nightly run at 50 students). Now we collect all candidates per entity
// type, then issue ONE `createMany` call per type wrapped in a single
// transaction that sets `app.tenant_id` once. Net: ~8 DB calls per tenant
// per pass (one per entity-type group + the initial findMany reads),
// regardless of candidate count.
//
// Background workers don't have a request scope, so RLS is satisfied by
// setting `app.tenant_id` ourselves at the start of every transaction.
//
// Title strings target an English-speaking admin audience. The format is
// stable enough that the dashboard can group by prefix when it wants to.

import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '../config/db.js';
import { logger } from '../config/logger.js';

// Days-before offsets per reminder type. Tuned so admins get a heads-up well
// before the deadline plus a final nudge. Sorted descending so the earliest
// reminder fires first.
const INTAKE_OFFSETS_DAYS = [30, 14, 7];
const PAYMENT_OFFSETS_DAYS = [14, 7, 3];
const EXPIRY_OFFSETS_DAYS = [60, 30, 14];
// SVT-COMPLIANCE-REMINDERS-2026-06 — statutory post-arrival deadlines (UK police
// registration ~7 days, BRP collection ~10 days, biometrics, CAS, medical) are
// short and hard, so the staircase is tight and ends with a same-window nudge.
const COMPLIANCE_OFFSETS_DAYS = [14, 7, 3, 1];
// Commission claims have no per-institution payment-terms column in the schema
// (the concept lives on SuperAgent, not Institution), so we chase on a flat
// default window until a real override is modelled.
const DEFAULT_COMMISSION_TERMS_DAYS = 30;

type DB = PrismaClient;

// Cache the default assignee per tenant — we look up "first ADMIN user" once
// per process boot. If a tenant has no admins we leave assigned_to_id null
// (the dispatcher falls back to a per-tenant lookup at send time).
const adminCache = new Map<string, string | null>();

async function defaultAssigneeFor(tenantId: string, db: DB): Promise<string | null> {
  if (adminCache.has(tenantId)) return adminCache.get(tenantId)!;
  const admin = await db.user.findFirst({
    where: { tenant_id: tenantId, role: 'ADMIN', is_active: true, deleted_at: null },
    orderBy: { created_at: 'asc' },
    select: { id: true },
  });
  const id = admin?.id ?? null;
  adminCache.set(tenantId, id);
  return id;
}

/** Public hook for tests — clears the per-tenant admin cache. */
export function _clearAdminCache() {
  adminCache.clear();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function startOfUtcDay(d: Date): Date {
  const c = new Date(d);
  c.setUTCHours(0, 0, 0, 0);
  return c;
}

// scheduled_for is "09:00 UTC, N days before the deadline" — early enough in
// the working day that any subsequent dispatcher pass within a couple of hours
// will pick it up before lunch in most timezones.
function scheduledForOffset(deadline: Date, daysBefore: number): Date {
  const d = startOfUtcDay(deadline);
  d.setUTCDate(d.getUTCDate() - daysBefore);
  d.setUTCHours(9, 0, 0, 0);
  return d;
}

// Money formatting for finance reminders. We display the major-unit amount
// with no fractional digits — admins can drill into the row for cents.
function formatMoneyMinor(amountMinor: bigint, currency: string): string {
  const major = Number(amountMinor) / 100;
  const rounded = Math.round(major).toLocaleString('en-US');
  return `${currency} ${rounded}`;
}

// The shape of a row we hand to `prisma.reminder.createMany`. We build this
// in-memory per entity type so all candidates ride a single round-trip.
type ReminderCreateRow = {
  tenant_id: string;
  student_id: string | null;
  enrollment_id: string | null;
  type: Prisma.ReminderUncheckedCreateInput['type'];
  source_entity_type: string;
  source_entity_id: string;
  title: string;
  due_on: Date;
  scheduled_for: Date;
  assigned_to_id: string | null;
  status: 'PENDING';
  metadata: Prisma.InputJsonValue | typeof Prisma.JsonNull;
  created_by_id: string;
};

// One transaction per entity-type group. We must `set_config` ourselves
// because the scanner runs outside the request scope. The unique constraint
// on (tenant_id, source_entity_type, source_entity_id, scheduled_for) plus
// skipDuplicates makes the bulk insert idempotent on re-runs.
async function bulkInsertReminders(
  tenantId: string,
  rows: ReminderCreateRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  try {
    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`,
      );
      // `skipDuplicates: true` translates to ON CONFLICT DO NOTHING against
      // the reminder_source_dedup unique. createMany itself is a single
      // multi-row INSERT regardless of `rows.length`.
      return tx.reminder.createMany({
        data: rows as never,
        skipDuplicates: true,
      });
    });
    return result.count;
  } catch (err) {
    logger.error(
      { err, tenantId, count: rows.length, sourceType: rows[0]?.source_entity_type ?? '?' },
      'reminder bulk insert failed',
    );
    return 0;
  }
}

// ---------------------------------------------------------------------------
// scanForTenant — entry point. Walks every source table for one tenant.
// ---------------------------------------------------------------------------

export type ScanResult = {
  tenantId: string;
  attempted: number;
  inserted: number; // createMany.count summed across entity-type groups (excludes ON CONFLICT skips)
  skipped: number; // past-dated rows we deliberately ignored
};

export async function scanForTenant(tenantId: string, db: DB = prisma): Promise<ScanResult> {
  const now = new Date();
  const result: ScanResult = { tenantId, attempted: 0, inserted: 0, skipped: 0 };

  const assignee = await defaultAssigneeFor(tenantId, db);
  // Without an admin, we cannot tag a creator either — fall back to the assignee
  // or, if none, a deterministic placeholder. The scanner shouldn't hard-fail
  // for tenants with no users yet.
  const creatorId = assignee ?? '00000000-0000-0000-0000-000000000000';

  // SVT-V2-TRACKER-2026-06 — section isolation. A single source query that
  // throws (e.g. the old commission-claim schema drift) must not abort the
  // whole scan and silently kill every later section's reminders. Each
  // section's read runs through this: on failure we log + yield [] so the
  // remaining sections still run. (bulkInsertReminders already self-contains
  // its own write failures.)
  async function safeFind<T>(section: string, run: () => Promise<T[]>): Promise<T[]> {
    try {
      return await run();
    } catch (err) {
      logger.error({ err, tenantId, section }, 'reminder scan: source query failed; section skipped');
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // 1. Intake start — Enrollment.program_intake.classes_start_on
  // -------------------------------------------------------------------------
  // Background workers run as the unscoped client, so we filter explicitly by
  // tenant_id and the relevant statuses. We need the intake row for the date
  // and label, so we include program_intake in the select.
  const enrollments = await safeFind('intake', () => db.enrollment.findMany({
    where: {
      tenant_id: tenantId,
      deleted_at: null,
      status: { in: ['ACCEPTED', 'ENROLLED', 'DEFERRED'] },
      program_intake: { is: { classes_start_on: { not: null } } },
    },
    select: {
      id: true,
      student_id: true,
      program_intake: {
        select: { id: true, intake_label: true, classes_start_on: true },
      },
    },
  }));
  {
    const rows: ReminderCreateRow[] = [];
    for (const enr of enrollments) {
      const intake = enr.program_intake;
      if (!intake?.classes_start_on || !intake.id) continue;
      for (const offset of INTAKE_OFFSETS_DAYS) {
        const scheduledFor = scheduledForOffset(intake.classes_start_on, offset);
        if (scheduledFor < now) {
          result.skipped++;
          continue;
        }
        result.attempted++;
        rows.push({
          tenant_id: tenantId,
          student_id: enr.student_id,
          enrollment_id: enr.id,
          type: 'INTAKE_START',
          source_entity_type: 'program_intake',
          source_entity_id: intake.id,
          title: `Intake starts in ${offset} days — ${intake.intake_label}`,
          due_on: intake.classes_start_on,
          scheduled_for: scheduledFor,
          assigned_to_id: assignee,
          status: 'PENDING',
          metadata: { offset_days: offset, intake_label: intake.intake_label, href: `/students/${enr.student_id}?tab=studies` },
          created_by_id: creatorId,
        });
      }
    }
    result.inserted += await bulkInsertReminders(tenantId, rows);
  }

  // -------------------------------------------------------------------------
  // 2. Tuition / payment due — FinanceItem.due_on (status PENDING)
  // -------------------------------------------------------------------------
  const items = await safeFind('finance_item', () => db.financeItem.findMany({
    where: {
      tenant_id: tenantId,
      status: 'PENDING',
      due_on: { not: null },
      // SVT-SYNC-2026-06: never remind on behalf of a soft-deleted student.
      student: { is: { deleted_at: null } },
    },
    select: {
      id: true,
      student_id: true,
      enrollment_id: true,
      amount_minor: true,
      currency: true,
      due_on: true,
      description: true,
      category: true,
    },
  }));
  {
    const rows: ReminderCreateRow[] = [];
    for (const fi of items) {
      if (!fi.due_on) continue;
      for (const offset of PAYMENT_OFFSETS_DAYS) {
        const scheduledFor = scheduledForOffset(fi.due_on, offset);
        if (scheduledFor < now) {
          result.skipped++;
          continue;
        }
        result.attempted++;
        const label = fi.category === 'TUITION' ? 'Tuition payment' : `${fi.category.toLowerCase()} payment`;
        rows.push({
          tenant_id: tenantId,
          student_id: fi.student_id,
          enrollment_id: fi.enrollment_id,
          type: 'PAYMENT_DUE',
          source_entity_type: 'finance_item',
          source_entity_id: fi.id,
          title: `${label.charAt(0).toUpperCase() + label.slice(1)} due in ${offset} days — ${formatMoneyMinor(fi.amount_minor, fi.currency)}`,
          due_on: fi.due_on,
          scheduled_for: scheduledFor,
          assigned_to_id: assignee,
          status: 'PENDING',
          metadata: { offset_days: offset, category: fi.category, href: `/students/${fi.student_id}?tab=finance` },
          created_by_id: creatorId,
        });
      }
    }
    result.inserted += await bulkInsertReminders(tenantId, rows);
  }

  // -------------------------------------------------------------------------
  // 3. Visa expiry — StudentVisa (is_active = true)
  // -------------------------------------------------------------------------
  const visas = await safeFind('student_visa', () => db.studentVisa.findMany({
    where: { tenant_id: tenantId, is_active: true, student: { is: { deleted_at: null } } },
    select: { id: true, student_id: true, expires_on: true, destination_country: true },
  }));
  {
    const rows: ReminderCreateRow[] = [];
    for (const v of visas) {
      for (const offset of EXPIRY_OFFSETS_DAYS) {
        const scheduledFor = scheduledForOffset(v.expires_on, offset);
        if (scheduledFor < now) {
          result.skipped++;
          continue;
        }
        result.attempted++;
        rows.push({
          tenant_id: tenantId,
          student_id: v.student_id,
          enrollment_id: null,
          type: 'VISA_EXPIRY',
          source_entity_type: 'student_visa',
          source_entity_id: v.id,
          title: `Visa expires in ${offset} days — ${v.destination_country}`,
          due_on: v.expires_on,
          scheduled_for: scheduledFor,
          assigned_to_id: assignee,
          status: 'PENDING',
          metadata: { offset_days: offset, destination_country: v.destination_country, href: `/students/${v.student_id}` },
          created_by_id: creatorId,
        });
      }
    }
    result.inserted += await bulkInsertReminders(tenantId, rows);
  }

  // -------------------------------------------------------------------------
  // 4. Passport expiry — StudentIdentification type=PASSPORT
  // -------------------------------------------------------------------------
  const passports = await safeFind('passport', () => db.studentIdentification.findMany({
    where: {
      tenant_id: tenantId,
      type: 'PASSPORT',
      expires_on: { not: null },
      student: { is: { deleted_at: null } },
    },
    select: { id: true, student_id: true, expires_on: true, issuing_country: true },
  }));
  {
    const rows: ReminderCreateRow[] = [];
    for (const p of passports) {
      if (!p.expires_on) continue;
      for (const offset of EXPIRY_OFFSETS_DAYS) {
        const scheduledFor = scheduledForOffset(p.expires_on, offset);
        if (scheduledFor < now) {
          result.skipped++;
          continue;
        }
        result.attempted++;
        rows.push({
          tenant_id: tenantId,
          student_id: p.student_id,
          enrollment_id: null,
          type: 'PASSPORT_EXPIRY',
          source_entity_type: 'student_identification',
          source_entity_id: p.id,
          title: `Passport expires in ${offset} days — ${p.issuing_country}`,
          due_on: p.expires_on,
          scheduled_for: scheduledFor,
          assigned_to_id: assignee,
          status: 'PENDING',
          metadata: { offset_days: offset, issuing_country: p.issuing_country, href: `/students/${p.student_id}` },
          created_by_id: creatorId,
        });
      }
    }
    result.inserted += await bulkInsertReminders(tenantId, rows);
  }

  // -------------------------------------------------------------------------
  // 5. Insurance expiry — InsuranceRecord.ends_on
  // -------------------------------------------------------------------------
  const insurances = await safeFind('insurance', () => db.insuranceRecord.findMany({
    where: { tenant_id: tenantId, student: { is: { deleted_at: null } } },
    select: { id: true, student_id: true, ends_on: true, provider: true },
  }));
  {
    const rows: ReminderCreateRow[] = [];
    for (const ins of insurances) {
      for (const offset of EXPIRY_OFFSETS_DAYS) {
        const scheduledFor = scheduledForOffset(ins.ends_on, offset);
        if (scheduledFor < now) {
          result.skipped++;
          continue;
        }
        result.attempted++;
        rows.push({
          tenant_id: tenantId,
          student_id: ins.student_id,
          enrollment_id: null,
          type: 'INSURANCE_EXPIRY',
          source_entity_type: 'insurance_record',
          source_entity_id: ins.id,
          title: `Insurance expires in ${offset} days — ${ins.provider}`,
          due_on: ins.ends_on,
          scheduled_for: scheduledFor,
          assigned_to_id: assignee,
          status: 'PENDING',
          metadata: { offset_days: offset, provider: ins.provider, href: `/students/${ins.student_id}` },
          created_by_id: creatorId,
        });
      }
    }
    result.inserted += await bulkInsertReminders(tenantId, rows);
  }

  // -------------------------------------------------------------------------
  // 5b. Compliance-check deadlines — ComplianceCheck.scheduled_at (not yet done)
  // -------------------------------------------------------------------------
  // SVT-COMPLIANCE-REMINDERS-2026-06 — biometric / police-registration / BRP /
  // CAS / medical checks carry a hard scheduled_at deadline. The model + UI
  // existed but nothing ever reminded on them, so a statutory window (e.g. UK
  // police registration) could lapse silently and breach the student's visa.
  // We chase any check that is NOT yet completed and whose deadline is upcoming.
  const complianceChecks = await safeFind('compliance_check', () => db.complianceCheck.findMany({
    where: {
      tenant_id: tenantId,
      completed_at: null,
      scheduled_at: { not: null },
      student: { is: { deleted_at: null } },
    },
    select: { id: true, student_id: true, check_type: true, scheduled_at: true },
  }));
  {
    const rows: ReminderCreateRow[] = [];
    for (const cc of complianceChecks) {
      if (!cc.scheduled_at) continue;
      const label = String(cc.check_type).replace(/_/g, ' ').toLowerCase();
      for (const offset of COMPLIANCE_OFFSETS_DAYS) {
        const scheduledFor = scheduledForOffset(cc.scheduled_at, offset);
        if (scheduledFor < now) {
          result.skipped++;
          continue;
        }
        result.attempted++;
        rows.push({
          tenant_id: tenantId,
          student_id: cc.student_id,
          enrollment_id: null,
          type: 'COMPLIANCE_CHECK_DUE',
          source_entity_type: 'compliance_check',
          source_entity_id: cc.id,
          title: `${label} due in ${offset} day${offset === 1 ? '' : 's'}`,
          due_on: cc.scheduled_at,
          scheduled_for: scheduledFor,
          assigned_to_id: assignee,
          status: 'PENDING',
          metadata: { offset_days: offset, check_type: cc.check_type, href: `/students/${cc.student_id}?tab=records` },
          created_by_id: creatorId,
        });
      }
    }
    result.inserted += await bulkInsertReminders(tenantId, rows);
  }

  // -------------------------------------------------------------------------
  // 6. Document expiry — Document.expires_on (active rows)
  // -------------------------------------------------------------------------
  const docs = await safeFind('document', () => db.document.findMany({
    where: {
      tenant_id: tenantId,
      deleted_at: null,
      expires_on: { not: null },
    },
    select: {
      id: true,
      student_id: true,
      expires_on: true,
      file_name: true,
      document_type: { select: { label: true } },
    },
  }));
  {
    const rows: ReminderCreateRow[] = [];
    for (const doc of docs) {
      if (!doc.expires_on) continue;
      for (const offset of EXPIRY_OFFSETS_DAYS) {
        const scheduledFor = scheduledForOffset(doc.expires_on, offset);
        if (scheduledFor < now) {
          result.skipped++;
          continue;
        }
        result.attempted++;
        const label = doc.document_type?.label ?? doc.file_name;
        rows.push({
          tenant_id: tenantId,
          student_id: doc.student_id,
          enrollment_id: null,
          type: 'DOCUMENT_EXPIRY',
          source_entity_type: 'document',
          source_entity_id: doc.id,
          title: `Document expires in ${offset} days — ${label}`,
          due_on: doc.expires_on,
          scheduled_for: scheduledFor,
          assigned_to_id: assignee,
          status: 'PENDING',
          metadata: { offset_days: offset, document_type: doc.document_type?.label ?? null, href: `/students/${doc.student_id}` },
          created_by_id: creatorId,
        });
      }
    }
    result.inserted += await bulkInsertReminders(tenantId, rows);
  }

  // -------------------------------------------------------------------------
  // 6b. Tracked-student session fees — TrackedStudentFee.due_on
  //    (SVT-V2-TRACKER-2026-06). Post-visa fee schedule ingested/seeded from
  //    the external V2 MIS and edited in SPV. Same PAYMENT_DUE staircase as
  //    finance items, but the reminder has NO `students` row — tracked students
  //    live in their own lightweight table — so student_id stays null and the
  //    dispatcher special-cases source_entity_type='tracked_student_fee'.
  //    Placed before the commission/enrollment scans so a failure in those
  //    (each section commits in its own tx) can't prevent fee reminders.
  // -------------------------------------------------------------------------
  const crmFees = await safeFind('crm_lead_fee', () => db.crmLeadFee.findMany({
    where: {
      tenant_id: tenantId,
      deleted_at: null,
      status: { in: ['SCHEDULED', 'DUE'] },
    },
    select: {
      id: true,
      lead_id: true,
      amount_minor: true,
      currency: true,
      due_on: true,
      session_label: true,
      lead: {
        select: { first_name: true, last_name: true, assigned_to_id: true },
      },
    },
  }));
  {
    const rows: ReminderCreateRow[] = [];
    for (const fee of crmFees) {
      const leadName = `${fee.lead?.first_name ?? ''} ${fee.lead?.last_name ?? ''}`.trim() || 'lead';
      for (const offset of PAYMENT_OFFSETS_DAYS) {
        const scheduledFor = scheduledForOffset(fee.due_on, offset);
        if (scheduledFor < now) {
          result.skipped++;
          continue;
        }
        result.attempted++;
        rows.push({
          tenant_id: tenantId,
          student_id: null,
          enrollment_id: null,
          type: 'PAYMENT_DUE',
          source_entity_type: 'crm_lead_fee',
          source_entity_id: fee.id,
          title: `Session fee due in ${offset} days — ${leadName} · ${fee.session_label} · ${formatMoneyMinor(fee.amount_minor, fee.currency)}`,
          due_on: fee.due_on,
          scheduled_for: scheduledFor,
          assigned_to_id: fee.lead?.assigned_to_id ?? assignee,
          status: 'PENDING',
          // Deep-link target for the bell/inbox → the lead's CRM record.
          metadata: { offset_days: offset, session_label: fee.session_label, crm_lead_fee: true, href: `/leads/${fee.lead_id}` },
          created_by_id: creatorId,
        });
      }
    }
    result.inserted += await bulkInsertReminders(tenantId, rows);
  }

  // -------------------------------------------------------------------------
  // 7. Commission claim payment overdue — CommissionClaim (CLAIMED/INVOICED)
  //
  // Once a claim is past institution.payment_terms_days (default 30 if unset)
  // it's effectively overdue. We fire reminders at the deadline + the
  // standard PAYMENT_OFFSETS_DAYS staircase so admin chases proactively rather
  // than via month-end reconciliation.
  // -------------------------------------------------------------------------
  // SVT-SCHEMA-DRIFT-2026-05 (fixed SVT-V2-TRACKER-2026-06) — the previous
  // `select` asked for `Institution.payment_terms_days`, a column that does NOT
  // exist (the concept lives on SuperAgent). Prisma threw at runtime, aborting
  // scanForTenant before sections 7 + 8 ever ran, so commission-claim and
  // enrollment-decision reminders were silently never generated. We now select
  // only real columns and chase on DEFAULT_COMMISSION_TERMS_DAYS; a true
  // per-institution override needs a schema migration first.
  const claims = await safeFind('commission_claim', () => db.commissionClaim.findMany({
    where: {
      tenant_id: tenantId,
      deleted_at: null,
      status: { in: ['CLAIMED', 'INVOICED'] },
      OR: [
        { invoiced_on: { not: null } },
        { claimed_on: { not: null } },
      ],
    },
    select: {
      id: true,
      student_id: true,
      enrollment_id: true,
      claimed_on: true,
      invoiced_on: true,
      amount_minor: true,
      currency: true,
      institution: { select: { id: true, display_name: true } },
    },
  }));
  {
    const rows: ReminderCreateRow[] = [];
    for (const cl of claims) {
      const anchor = cl.invoiced_on ?? cl.claimed_on;
      if (!anchor) continue;
      const terms = DEFAULT_COMMISSION_TERMS_DAYS;
      const due = new Date(anchor);
      due.setDate(due.getDate() + terms);
      for (const offset of PAYMENT_OFFSETS_DAYS) {
        const scheduledFor = scheduledForOffset(due, offset);
        if (scheduledFor < now) {
          result.skipped++;
          continue;
        }
        result.attempted++;
        rows.push({
          tenant_id: tenantId,
          student_id: cl.student_id,
          enrollment_id: cl.enrollment_id,
          type: 'COMMISSION_CLAIM_DUE',
          source_entity_type: 'commission_claim',
          source_entity_id: cl.id,
          title: `Commission due in ${offset} days from ${cl.institution?.display_name ?? 'institution'} — ${formatMoneyMinor(cl.amount_minor, cl.currency)}`,
          due_on: due,
          scheduled_for: scheduledFor,
          assigned_to_id: assignee,
          status: 'PENDING',
          metadata: {
            offset_days: offset,
            institution_id: cl.institution?.id ?? null,
            terms_days: terms,
            href: '/commissions',
          },
          created_by_id: creatorId,
        });
      }
    }
    result.inserted += await bulkInsertReminders(tenantId, rows);
  }

  // -------------------------------------------------------------------------
  // 8. Enrollment decision overdue — Enrollment (OFFERED with start_date set)
  //
  // OFFERED enrollments whose start_date is approaching but status hasn't
  // advanced should prompt the counsellor to chase the student. We use
  // start_date as the deadline anchor since program_intake.decision_date is
  // optional (and most consultancies use start_date as the practical deadline).
  // -------------------------------------------------------------------------
  const offered = await safeFind('enrollment_decision', () => db.enrollment.findMany({
    where: {
      tenant_id: tenantId,
      deleted_at: null,
      status: 'OFFERED',
      start_date: { not: null },
    },
    select: {
      id: true,
      student_id: true,
      start_date: true,
      institution: { select: { display_name: true } },
    },
  }));
  {
    const rows: ReminderCreateRow[] = [];
    for (const enr of offered) {
      if (!enr.start_date) continue;
      for (const offset of PAYMENT_OFFSETS_DAYS) {
        const scheduledFor = scheduledForOffset(enr.start_date, offset);
        if (scheduledFor < now) {
          result.skipped++;
          continue;
        }
        result.attempted++;
        rows.push({
          tenant_id: tenantId,
          student_id: enr.student_id,
          enrollment_id: enr.id,
          type: 'ENROLLMENT_DECISION_DUE',
          source_entity_type: 'enrollment',
          source_entity_id: enr.id,
          title: `Enrollment decision due in ${offset} days — ${enr.institution?.display_name ?? 'institution'}`,
          due_on: enr.start_date,
          scheduled_for: scheduledFor,
          assigned_to_id: assignee,
          status: 'PENDING',
          metadata: { offset_days: offset, href: `/students/${enr.student_id}?tab=studies` },
          created_by_id: creatorId,
        });
      }
    }
    result.inserted += await bulkInsertReminders(tenantId, rows);
  }

  logger.info(result, 'reminder scan complete');
  return result;
}
