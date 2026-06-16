// SVT-V2-CRM-MIRROR-2026-06 — ingest the V2 MIS CRM into SPVT's crm_* mirror.
//
// Topological multi-entity upsert (parents before children) with in-memory
// v2-id → SPVT-uuid maps for FK resolution. Single configured tenant
// (V2_INGEST_TENANT_ID), gated by V2_INGEST_ENABLED. Each row is upserted in
// its own tenant-scoped transaction with try/catch so one bad row can't sink
// the batch. Upserts refresh V2 SOURCE columns + synced_at only — SPVT-owned
// columns (spv_status / assigned_to_id / spv_notes / fee edits) are preserved.
//
// Called from the daily scheduler (runV2IngestPass) and on-demand /leads/sync.

import { Prisma } from '@prisma/client';
import { prisma } from '../config/db.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { fetchV2Crm } from '../integrations/v2-mis/queries.js';
import { decimalToMinor } from '../shared/money.js';
import type { JobOutcome } from './runner.js';

async function withTenantTx<T>(
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}


// Return value only if it is one of the allowed enum values, else null. Keeps
// a row insertable when V2 carries a value outside SPVT's mirrored enum.
function oneOf<T extends string>(value: string | null | undefined, allowed: readonly T[]): T | null {
  return value != null && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

const LEAD_COURSE_STATES = [
  'documents_collection', 'application_form', 'offer_received_unconditional',
  'offer_received_conditional', 'offer_accepted', 'offer_rejected',
  'visa_lodgement', 'visa_accepted', 'visa_refused',
] as const;

// V2 dual-writes LeadCourses.state (legacy free-text) + stateV2 (typed enum).
// stateV2 is sparsely backfilled, so when it's null we derive the enum from the
// legacy free-text — but ONLY for UNAMBIGUOUS funnel labels. Ambiguous values
// (draft / applied / accepted / rejected / "GS Rejected" / "Offer Withdrawn")
// stay null so we never mis-stage a finance record; the raw text is still
// mirrored verbatim in the `state` column for display + audit.
const LEGACY_STATE_TO_ENUM: Record<string, (typeof LEAD_COURSE_STATES)[number]> = {
  'visa accepted': 'visa_accepted',
  'visa granted': 'visa_accepted',
  'visa refused': 'visa_refused',
  'visa rejected': 'visa_refused',
  'visa lodgement': 'visa_lodgement',
  'visa lodged': 'visa_lodgement',
  'offer received - unconditional': 'offer_received_unconditional',
  'unconditional offer': 'offer_received_unconditional',
  'offer received - conditional': 'offer_received_conditional',
  'conditional offer': 'offer_received_conditional',
  'offer accepted': 'offer_accepted',
  'offer rejected': 'offer_rejected',
  'documents collection': 'documents_collection',
  'document collection': 'documents_collection',
  'application form': 'application_form',
};

function leadCourseStateEnum(
  stateV2: string | null | undefined,
  legacyState: string | null | undefined,
): (typeof LEAD_COURSE_STATES)[number] | null {
  const typed = oneOf(stateV2, LEAD_COURSE_STATES);
  if (typed) return typed;
  if (legacyState) {
    const key = legacyState.trim().toLowerCase().replace(/\s+/g, ' ');
    return LEGACY_STATE_TO_ENUM[key] ?? null;
  }
  return null;
}
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'VIP'] as const;
const PROFILE_STATES = ['complete', 'incomplete'] as const;
const VISIT_OUTCOMES = ['REGISTERED', 'COUNSELLED', 'FOLLOW_UP_NEEDED', 'NO_SHOW', 'LOST'] as const;

export type IngestResult = {
  rowsProcessed: number;
  rowsFailed: number;
  studentsUpserted: number;
  feesSeeded: number;
};

export async function ingestForTenant(tenantId: string): Promise<IngestResult> {
  const dump = await fetchV2Crm();
  const res: IngestResult = { rowsProcessed: 0, rowsFailed: 0, studentsUpserted: 0, feesSeeded: 0 };

  // v2-id → SPVT-uuid maps, populated as each parent level upserts.
  const countryMap = new Map<number, string>();
  const institutionMap = new Map<number, string>();
  const courseMap = new Map<number, string>();
  const leadMap = new Map<number, string>();

  // Per-row upsert helper: own tenant-scoped tx + try/catch + counters.
  async function up(
    label: string,
    v2Id: number | string,
    run: (tx: Prisma.TransactionClient) => Promise<{ id: string }>,
  ): Promise<string | null> {
    try {
      const r = await withTenantTx(tenantId, run);
      res.rowsProcessed++;
      return r.id;
    } catch (err) {
      res.rowsFailed++;
      logger.error({ err, tenantId, entity: label, v2Id }, 'v2.ingest row failed');
      return null;
    }
  }

  // ── 1. Countries ──
  for (const c of dump.countries) {
    const id = await up('country', c.id, (tx) =>
      tx.crmCountry.upsert({
        where: { crm_country_v2_dedup: { tenant_id: tenantId, v2_country_id: c.id } },
        create: { tenant_id: tenantId, v2_country_id: c.id, name: c.name, signature: c.signature, currency_code: c.currency_code, synced_at: new Date() },
        update: { name: c.name, signature: c.signature, currency_code: c.currency_code, synced_at: new Date() },
        select: { id: true },
      }),
    );
    if (id) countryMap.set(c.id, id);
  }

  // ── 2. Institutions ──
  for (const i of dump.institutions) {
    const src = {
      name: i.name, email: i.email, phone: i.phone, street: i.street, city: i.city,
      state: i.state, post_code: i.post_code, currency_code: i.currency_code,
      category: i.category, logo: i.logo, is_active: i.isActive,
      v2_country_id: i.countryId, country_id: countryMap.get(i.countryId) ?? null, synced_at: new Date(),
    };
    const id = await up('institution', i.id, (tx) =>
      tx.crmInstitution.upsert({
        where: { crm_institution_v2_dedup: { tenant_id: tenantId, v2_institution_id: i.id } },
        create: { tenant_id: tenantId, v2_institution_id: i.id, ...src },
        update: src,
        select: { id: true },
      }),
    );
    if (id) institutionMap.set(i.id, id);
  }

  // ── 3. Courses ──
  for (const c of dump.courses) {
    const src = {
      name: c.name, description: c.description, type: c.type, category: c.category,
      start_date: c.start_date, end_date: c.end_date, fee_legacy: c.fee,
      fee_amount_minor: decimalToMinor(c.feeAmount, c.feeCurrency ?? env.V2_INGEST_DEFAULT_CURRENCY), fee_currency: c.feeCurrency?.slice(0, 3).toUpperCase() ?? null,
      v2_institution_id: c.institutionId, institution_id: c.institutionId != null ? institutionMap.get(c.institutionId) ?? null : null,
      synced_at: new Date(),
    };
    const id = await up('course', c.id, (tx) =>
      tx.crmCourse.upsert({
        where: { crm_course_v2_dedup: { tenant_id: tenantId, v2_course_id: c.id } },
        create: { tenant_id: tenantId, v2_course_id: c.id, ...src },
        update: src,
        select: { id: true },
      }),
    );
    if (id) courseMap.set(c.id, id);
  }

  // ── 4. Leads (the person; SPVT-owned cols preserved on update) ──
  // SVT-SYNC-2026-06: never re-populate a DSAR-erased lead. eraseStudent redacts
  // + soft-deletes the mirror lead, and deleted_at on CrmLead is set ONLY by
  // erasure — so this set targets erased rows precisely. Skipping the lead also
  // skips its children (no leadMap entry → the child loops below can't resolve
  // the FK), freezing the whole subject's mirror against the upstream copy.
  const erasedLeadV2Ids = new Set(
    (
      await withTenantTx(tenantId, (tx) =>
        tx.crmLead.findMany({
          where: { tenant_id: tenantId, deleted_at: { not: null } },
          select: { v2_lead_id: true },
        }),
      )
    ).map((r) => r.v2_lead_id),
  );
  for (const l of dump.leads) {
    if (erasedLeadV2Ids.has(l.id)) continue;
    const src = {
      first_name: l.first_name, last_name: l.last_name, phone_number: l.phone_number,
      secondary_number: l.secondary_number, gender: l.gender, address: l.address, dob: l.dob,
      email: l.email, city: l.city, source: l.source, type: l.type,
      interested_course: l.interested_course, field_of_study: l.field_of_study, intake_month: l.intake_month,
      application_status: l.application_status, profile_status: l.profile_status,
      profile_state: oneOf(l.profile_statusV2, PROFILE_STATES),
      counsellor_status: l.counsellor_status, is_archived: l.isArchived ?? false, dropout: l.dropout,
      priority: oneOf(l.priority, PRIORITIES) ?? 'NORMAL', tags: l.tags ?? [],
      slc_institution_name: l.slc_institution_name, slc_grade: l.slc_grade, slc_year: l.slc_year,
      highschool_institution_name: l.highschool_institution_name, highschool_grade: l.highschool_grade, highschool_year: l.highschool_year,
      bachelors_institution_name: l.bachelors_institution_name, bachelors_grade: l.bachelors_grade, bachelors_year: l.bachelors_year,
      masters_institution_name: l.masters_institution_name, masters_grade: l.masters_grade, masters_year: l.masters_year,
      ielts_overall_score: l.ielts_overall_score, ielts_listening_score: l.ielts_listening_score, ielts_reading_score: l.ielts_reading_score,
      ielts_writing_score: l.ielts_writing_score, ielts_speaking_score: l.ielts_speaking_score, ielts_date: l.ielts_date,
      pte_overall_score: l.pte_overall_score, pte_listening_score: l.pte_listening_score, pte_reading_score: l.pte_reading_score,
      pte_writing_score: l.pte_writing_score, pte_speaking_score: l.pte_speaking_score, pte_date: l.pte_date,
      sat_overall_score: l.sat_overall_score, sat_math_score: l.sat_math_score, sat_reading_score: l.sat_reading_score,
      sat_writing_and_language_score: l.sat_writing_and_language_score, sat_date: l.sat_date,
      utm_source: l.utmSource, utm_medium: l.utmMedium, utm_campaign: l.utmCampaign, utm_term: l.utmTerm, utm_content: l.utmContent,
      landing_page: l.landingPage, referrer: l.referrer, first_touched_at: l.firstTouchedAt,
      v2_created_at: l.createdAt, v2_updated_at: l.updatedAt, synced_at: new Date(),
    };
    const id = await up('lead', l.id, (tx) =>
      tx.crmLead.upsert({
        where: { crm_lead_v2_dedup: { tenant_id: tenantId, v2_lead_id: l.id } },
        create: { tenant_id: tenantId, v2_lead_id: l.id, ...src },
        update: src, // SPVT-owned (spv_status/assigned_to_id/spv_notes) intentionally absent
        select: { id: true },
      }),
    );
    if (id) { leadMap.set(l.id, id); res.studentsUpserted++; }
  }

  // ── 5. Applications ──
  for (const a of dump.applications) {
    const leadId = leadMap.get(a.leadId);
    const courseId = courseMap.get(a.courseId);
    if (!leadId || !courseId) { res.rowsFailed++; continue; }
    const src = {
      intake_key: a.intakeKey, state: a.state ?? 'draft', notes: a.notes,
      started_at: a.startedAt, completed_at: a.completedAt,
      v2_created_at: a.createdAt, v2_updated_at: a.updatedAt, v2_deleted_at: a.deletedAt,
      v2_lead_id: a.leadId, v2_course_id: a.courseId, lead_id: leadId, course_id: courseId, synced_at: new Date(),
    };
    await up('application', a.id, (tx) =>
      tx.crmApplication.upsert({
        where: { crm_application_v2_dedup: { tenant_id: tenantId, v2_application_id: a.id } },
        create: { tenant_id: tenantId, v2_application_id: a.id, ...src },
        update: src,
        select: { id: true },
      }),
    );
  }

  // ── 6. Lead-courses (funnel state) ──
  for (const lc of dump.leadCourses) {
    const leadId = leadMap.get(lc.leadId);
    const courseId = courseMap.get(lc.courseId);
    if (!leadId || !courseId) { res.rowsFailed++; continue; }
    const src = {
      state: lc.state, state_v2: leadCourseStateEnum(lc.stateV2, lc.state), sub_state: lc.subState,
      start_date: lc.startDate, end_date: lc.endDate, is_deleted: lc.isDeleted ?? false,
      v2_created_at: lc.createdAt, v2_updated_at: lc.updatedAt,
      v2_lead_id: lc.leadId, v2_course_id: lc.courseId, lead_id: leadId, course_id: courseId, synced_at: new Date(),
    };
    await up('lead_course', `${lc.leadId}/${lc.courseId}`, (tx) =>
      tx.crmLeadCourse.upsert({
        where: { crm_lead_course_v2_dedup: { tenant_id: tenantId, v2_lead_id: lc.leadId, v2_course_id: lc.courseId } },
        create: { tenant_id: tenantId, ...src },
        update: src,
        select: { id: true },
      }),
    );
  }

  // ── 7. Lead-course history (append-only) ──
  for (const h of dump.history) {
    const leadId = leadMap.get(h.leadId);
    if (!leadId) { res.rowsFailed++; continue; }
    const src = {
      from_state: h.fromState, to_state: h.toState, changed_by: h.changedBy, changed_at: h.changedAt,
      v2_lead_id: h.leadId, v2_course_id: h.courseId, lead_id: leadId,
      course_id: courseMap.get(h.courseId) ?? null, synced_at: new Date(),
    };
    await up('history', h.id, (tx) =>
      tx.crmLeadCourseHistory.upsert({
        where: { crm_lead_course_history_v2_dedup: { tenant_id: tenantId, v2_history_id: h.id } },
        create: { tenant_id: tenantId, v2_history_id: h.id, ...src },
        update: src,
        select: { id: true },
      }),
    );
  }

  // ── 8. Payments (lead via Student.leadId join) ──
  for (const p of dump.payments) {
    const leadId = leadMap.get(p.lead_v2_id);
    if (!leadId) { res.rowsFailed++; continue; }
    const src = {
      amount_minor: decimalToMinor(p.amount, p.currency ?? 'NPR') ?? 0n, currency: (p.currency ?? 'NPR').slice(0, 3).toUpperCase(),
      method: p.method, cash_amount_minor: decimalToMinor(p.cashAmount, p.currency ?? 'NPR'), online_amount_minor: decimalToMinor(p.onlineAmount, p.currency ?? 'NPR'),
      bank_ref: p.bankRef, voucher_no: p.voucherNo, receipt_no: p.receiptNo, received_by: p.receivedById,
      received_at: p.receivedAt, notes: p.notes,
      v2_student_id: p.studentId, v2_lead_id: p.lead_v2_id, v2_class_id: p.classId, lead_id: leadId, synced_at: new Date(),
    };
    await up('payment', p.id, (tx) =>
      tx.crmPayment.upsert({
        where: { crm_payment_v2_dedup: { tenant_id: tenantId, v2_payment_id: p.id } },
        create: { tenant_id: tenantId, v2_payment_id: p.id, ...src } as Prisma.CrmPaymentUncheckedCreateInput,
        update: src as Prisma.CrmPaymentUncheckedUpdateInput,
        select: { id: true },
      }),
    );
  }

  // ── 9. Activity: remarks / follow-ups / calls / visits / assignments ──
  for (const r of dump.remarks) {
    const leadId = leadMap.get(r.leadId);
    if (!leadId) { res.rowsFailed++; continue; }
    const src = { content: r.content, v2_user_id: r.userId, v2_created_at: r.createdAt, v2_updated_at: r.updatedAt, v2_lead_id: r.leadId, lead_id: leadId, synced_at: new Date() };
    await up('remark', r.id, (tx) => tx.crmRemark.upsert({ where: { crm_remark_v2_dedup: { tenant_id: tenantId, v2_remark_id: r.id } }, create: { tenant_id: tenantId, v2_remark_id: r.id, ...src }, update: src, select: { id: true } }));
  }
  for (const f of dump.followUps) {
    const leadId = leadMap.get(f.leadId);
    if (!leadId) { res.rowsFailed++; continue; }
    const src = { date: f.date, status: f.status, v2_user_id: f.userId, v2_created_at: f.createdAt, v2_lead_id: f.leadId, lead_id: leadId, synced_at: new Date() };
    await up('follow_up', f.id, (tx) => tx.crmFollowUp.upsert({ where: { crm_follow_up_v2_dedup: { tenant_id: tenantId, v2_follow_up_id: f.id } }, create: { tenant_id: tenantId, v2_follow_up_id: f.id, ...src }, update: src, select: { id: true } }));
  }
  for (const c of dump.calls) {
    const leadId = leadMap.get(c.leadId);
    if (!leadId) { res.rowsFailed++; continue; }
    const src = { status: c.status, notes: c.notes, v2_user_id: c.userId, v2_created_at: c.createdAt, v2_lead_id: c.leadId, lead_id: leadId, synced_at: new Date() };
    await up('call', c.id, (tx) => tx.crmCallHistory.upsert({ where: { crm_call_v2_dedup: { tenant_id: tenantId, v2_call_id: c.id } }, create: { tenant_id: tenantId, v2_call_id: c.id, ...src }, update: src, select: { id: true } }));
  }
  for (const v of dump.visits) {
    const leadId = leadMap.get(v.leadId);
    if (!leadId) { res.rowsFailed++; continue; }
    const src = { date: v.date, purpose: v.purpose, outcome: oneOf(v.outcome, VISIT_OUTCOMES), v2_user_id: v.userId, v2_actor_id: v.actorId, v2_branch_id: v.branchId, v2_campaign_id: v.campaignId, v2_created_at: v.createdAt, v2_updated_at: v.updatedAt, v2_lead_id: v.leadId, lead_id: leadId, synced_at: new Date() };
    await up('visit', v.id, (tx) => tx.crmVisit.upsert({ where: { crm_visit_v2_dedup: { tenant_id: tenantId, v2_visit_id: v.id } }, create: { tenant_id: tenantId, v2_visit_id: v.id, ...src }, update: src, select: { id: true } }));
  }
  for (const a of dump.assignments) {
    const leadId = leadMap.get(a.leadId);
    if (!leadId) { res.rowsFailed++; continue; }
    const src = { kind: a.kind, v2_user_id: a.userId, is_active: a.isActive ?? false, v2_created_at: a.createdAt, v2_updated_at: a.updatedAt, v2_lead_id: a.leadId, lead_id: leadId, synced_at: new Date() };
    await up('assignment', `${a.kind}:${a.id}`, (tx) => tx.crmAssignment.upsert({ where: { crm_assignment_v2_dedup: { tenant_id: tenantId, kind: a.kind, v2_assignment_id: a.id } }, create: { tenant_id: tenantId, v2_assignment_id: a.id, ...src }, update: src, select: { id: true } }));
  }

  // ── 10. Applicant profile: qualifications / language tests / guardians ──
  for (const qf of dump.qualifications) {
    const leadId = leadMap.get(qf.leadId);
    if (!leadId) { res.rowsFailed++; continue; }
    const src = {
      level: qf.level, institution_name: qf.institution_name, board_or_university: qf.board_or_university,
      stream_or_major: qf.stream_or_major, grade: qf.grade, grade_scale: oneOf(qf.grade_scale, ['PERCENT', 'CGPA_4', 'CGPA_10', 'DIVISION', 'LETTER'] as const),
      start_year: qf.start_year, end_year: qf.end_year, is_ongoing: qf.is_ongoing ?? false,
      division: oneOf(qf.division, ['FIRST', 'SECOND', 'THIRD', 'PASS'] as const), notes: qf.notes,
      v2_created_at: qf.createdAt, v2_updated_at: qf.updatedAt, v2_lead_id: qf.leadId, lead_id: leadId, synced_at: new Date(),
    };
    await up('qualification', qf.id, (tx) => tx.crmQualification.upsert({ where: { crm_qualification_v2_dedup: { tenant_id: tenantId, v2_qualification_id: qf.id } }, create: { tenant_id: tenantId, v2_qualification_id: qf.id, ...src } as Prisma.CrmQualificationUncheckedCreateInput, update: src as Prisma.CrmQualificationUncheckedUpdateInput, select: { id: true } }));
  }
  for (const t of dump.languageTests) {
    const leadId = leadMap.get(t.leadId);
    if (!leadId) { res.rowsFailed++; continue; }
    const src = {
      test_type: t.test_type, custom_test_name: t.custom_test_name, test_date: t.test_date,
      overall_score: t.overall_score, listening_score: t.listening_score, reading_score: t.reading_score,
      writing_score: t.writing_score, speaking_score: t.speaking_score,
      extra_scores: (t.extra_scores ?? undefined) as Prisma.InputJsonValue | undefined,
      test_center: t.test_center, reference_no: t.reference_no, is_official: t.is_official ?? true, notes: t.notes,
      v2_created_at: t.createdAt, v2_updated_at: t.updatedAt, v2_lead_id: t.leadId, lead_id: leadId, synced_at: new Date(),
    };
    await up('language_test', t.id, (tx) => tx.crmLanguageTest.upsert({ where: { crm_language_test_v2_dedup: { tenant_id: tenantId, v2_language_test_id: t.id } }, create: { tenant_id: tenantId, v2_language_test_id: t.id, ...src } as Prisma.CrmLanguageTestUncheckedCreateInput, update: src as Prisma.CrmLanguageTestUncheckedUpdateInput, select: { id: true } }));
  }
  for (const g of dump.guardians) {
    const leadId = leadMap.get(g.leadId);
    if (!leadId) { res.rowsFailed++; continue; }
    const src = {
      full_name: g.full_name, relationship_type: g.relationship_type, custom_relationship_label: g.custom_relationship_label,
      phone: g.phone, secondary_phone: g.secondary_phone, email: g.email, address: g.address, occupation: g.occupation, notes: g.notes,
      v2_created_at: g.createdAt, v2_updated_at: g.updatedAt, v2_lead_id: g.leadId, lead_id: leadId, synced_at: new Date(),
    };
    await up('guardian', g.id, (tx) => tx.crmGuardian.upsert({ where: { crm_guardian_v2_dedup: { tenant_id: tenantId, v2_guardian_id: g.id } }, create: { tenant_id: tenantId, v2_guardian_id: g.id, ...src } as Prisma.CrmGuardianUncheckedCreateInput, update: src as Prisma.CrmGuardianUncheckedUpdateInput, select: { id: true } }));
  }

  // ── 11. Seed post-visa fee schedule (SPVT-owned) from visa-accepted lead-courses ──
  // Hybrid: only when the course has a fee amount AND the lead-course has a start
  // date to anchor due_on. Idempotent via crm_lead_fees_seed_uq; never clobbers edits.
  const visaAccepted = dump.leadCourses.filter(
    (lc) => leadCourseStateEnum(lc.stateV2, lc.state) === 'visa_accepted' && lc.startDate,
  );
  for (const lc of visaAccepted) {
    const leadId = leadMap.get(lc.leadId);
    const course = dump.courses.find((c) => c.id === lc.courseId);
    const amount = decimalToMinor(course?.feeAmount ?? null, course?.feeCurrency ?? env.V2_INGEST_DEFAULT_CURRENCY);
    if (!leadId || amount == null || !lc.startDate) continue;
    try {
      const seeded = await withTenantTx(tenantId, (tx) =>
        tx.crmLeadFee.createMany({
          data: [{
            tenant_id: tenantId, lead_id: leadId,
            session_label: course?.name ? `${course.name} — Session 1` : 'V2 session fee',
            amount_minor: amount,
            currency: (course?.feeCurrency ?? env.V2_INGEST_DEFAULT_CURRENCY).slice(0, 3).toUpperCase(),
            due_on: lc.startDate!, status: 'SCHEDULED', seeded_from_v2: true,
          }],
          skipDuplicates: true,
        }),
      );
      res.feesSeeded += seeded.count;
    } catch (err) {
      logger.error({ err, tenantId, v2_lead_id: lc.leadId }, 'v2.ingest fee seed failed');
    }
  }

  logger.info({ tenantId, ...res }, 'v2.ingest complete');
  return res;
}

/** Scheduler entry point — targets the single configured tenant. */
export async function runV2IngestPass(): Promise<JobOutcome> {
  const tenantId = env.V2_INGEST_TENANT_ID;
  if (!env.V2_INGEST_ENABLED || !tenantId) {
    logger.warn('v2.ingest skipped: disabled or no V2_INGEST_TENANT_ID configured');
    return { rowsProcessed: 0, rowsFailed: 0, metadata: { skipped: 'disabled_or_no_tenant' } };
  }
  const tenant = await prisma.tenant.findFirst({ where: { id: tenantId, is_active: true }, select: { id: true } });
  if (!tenant) throw new Error(`V2_INGEST_TENANT_ID ${tenantId} not found or inactive`);
  const r = await ingestForTenant(tenantId);
  return {
    rowsProcessed: r.rowsProcessed,
    rowsFailed: r.rowsFailed,
    metadata: { studentsUpserted: r.studentsUpserted, feesSeeded: r.feesSeeded, tenant: tenantId },
  };
}
