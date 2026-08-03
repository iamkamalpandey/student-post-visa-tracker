// SVT-GDPR-2026-05 — GDPR Art. 30 Records of Processing Activities (ROPA).
//
// GET /api/v1/admin/ropa            → JSON (default)
// GET /api/v1/admin/ropa.csv        → CSV
//
// Aggregates:
//   - Static ACTIVITY_CATALOG (one row per data-processing purpose in SVT)
//     covering: purpose, lawful basis, data categories, retention, special
//     category flag, recipients.
//   - Live SubProcessor list (Art 28(2) register) from the SubProcessor
//     table — tenant-scoped.
//   - DSAR counts per type/status — operational evidence.
//   - ConsentRecord counts per lawful basis — operational evidence.
//
// ADMIN-only. The endpoint is the regulator-handoff format; humans should
// also be able to download CSV for spreadsheet use.

import { Router } from 'express';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import { tenantContext } from '../../middlewares/tenantContext.js';
import { writeAudit } from '../../shared/audit.js';
// SVT-QA-2026-08 — routes now read via req.db (the tenantContext-scoped
// client) instead of the raw prisma singleton. Under the future spv_app
// runtime role, raw prisma queries return zero rows because app.tenant_id
// GUC is unset — this route would silently show an empty ROPA export.
// Panel finding §Backend §14 [rls-scope].

export const ropaRouter: Router = Router();
ropaRouter.use(authenticate, tenantContext, requireRole('ADMIN'));

// Static catalogue — one row per processing activity. Update here when a
// new processing purpose is added. Lawful_basis values mirror the
// LawfulBasis enum in the Prisma schema.
const ACTIVITY_CATALOG = [
  {
    activity: 'student_lifecycle_management',
    purpose: 'Manage post-visa student lifecycle (travel, arrival, enrolment, compliance)',
    lawful_basis: 'CONTRACT',
    data_categories: [
      'identity', 'contact', 'passport_number', 'visa_number', 'travel_itinerary',
      'address', 'date_of_birth', 'nationality', 'academic_records',
    ],
    special_category_data: false,
    recipients: ['internal_counsellors', 'partner_institutions'],
    retention: '7 years post-completion (configurable per DocumentType)',
    cross_border_transfer: 'destination country of study (EU/UK/AU/US/CA) per Tenant.data_residency_region',
  },
  {
    activity: 'health_compliance_data',
    purpose: 'Track medical exams, biometrics, TB tests required by destination visas',
    lawful_basis: 'LEGAL_OBLIGATION',
    data_categories: ['medical_exam_results', 'biometrics_appointment', 'tb_test_status'],
    special_category_data: true,
    art9_condition: 'SUBSTANTIAL_PUBLIC_INTEREST (immigration compliance)',
    recipients: ['internal_counsellors', 'destination_government_authorities'],
    retention: 'Until visa expiry + 1 year',
  },
  {
    activity: 'commission_invoicing',
    purpose: 'Calculate + invoice institution-paid commissions on enrolment',
    lawful_basis: 'LEGITIMATE_INTEREST',
    data_categories: ['enrolment_status', 'tuition_amount', 'institution_id'],
    special_category_data: false,
    recipients: ['internal_admins', 'partner_institutions'],
    retention: '10 years for financial records',
  },
  {
    activity: 'fee_billing',
    purpose: 'School/college tuition installments, payment receipts, refunds',
    lawful_basis: 'CONTRACT',
    data_categories: ['enrolment_status', 'payment_method', 'amount', 'receipt_no'],
    special_category_data: false,
    recipients: ['internal_admins', 'payment_provider'],
    retention: '10 years for financial records',
  },
  {
    activity: 'comms_outbound',
    purpose: 'Email/SMS reminders, status updates, marketing (where consented)',
    lawful_basis: 'CONTRACT / CONSENT (marketing)',
    data_categories: ['email', 'phone', 'message_content'],
    special_category_data: false,
    recipients: ['Resend (email)', 'opt-in SMS providers'],
    retention: 'Comms history pruned after 30 days; opt-out preserved indefinitely',
  },
  {
    activity: 'audit_log',
    purpose: 'Tamper-evident operational audit trail (security + regulator)',
    lawful_basis: 'LEGAL_OBLIGATION',
    data_categories: ['actor_id', 'action', 'entity_id', 'ip_hash', 'ua_hash', 'request_id'],
    special_category_data: false,
    recipients: ['internal_admins', 'auditors'],
    retention: '7 years; hash chain anchored daily',
  },
  {
    activity: 'dsar_handling',
    purpose: 'Process subject rights requests (access/erasure/portability/etc.)',
    lawful_basis: 'LEGAL_OBLIGATION',
    data_categories: ['dsar_request', 'subject_export_payload'],
    special_category_data: false,
    recipients: ['DSAR officer', 'requesting subject'],
    retention: '7 years for compliance evidence',
  },
  {
    activity: 'breach_incident_management',
    purpose: 'Track breach detection → containment → 72h notification',
    lawful_basis: 'LEGAL_OBLIGATION',
    data_categories: ['breach_metadata', 'affected_subject_count', 'remediation_status'],
    special_category_data: false,
    recipients: ['DPO', 'supervisory authority (regulator)'],
    retention: '10 years',
  },
];

function csvEscape(v: unknown): string {
  if (v == null) return '';
  let s = String(v);
  // CSV injection guard (mirrors exports/writers.ts).
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    s = `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

ropaRouter.get('/ropa', async (req, res, next) => {
  try {
    const tenantId = req.user!.tid;
    if (!req.db) throw new Error('tenantContext middleware not applied');
    const db = req.db;
    const [subProcessors, dsarCounts, consentCounts] = await Promise.all([
      db.subProcessor.findMany({
        where: { tenant_id: tenantId, removed_at: null },
        orderBy: { added_at: 'asc' },
        take: 1000,
      }),
      db.dSARRequest.groupBy({
        by: ['type', 'status'],
        where: { tenant_id: tenantId },
        _count: true,
      }).catch(() => [] as Array<{ type: string; status: string; _count: number }>),
      db.consentRecord.groupBy({
        by: ['lawful_basis', 'granted'],
        where: { tenant_id: tenantId },
        _count: true,
      }).catch(() => [] as Array<{ lawful_basis: string; granted: boolean; _count: number }>),
    ]);

    // SVT-AUDIT-NAMING-2026-05 — use canonical writeAudit DTO shape (camelCase)
    // that the rest of the codebase uses. Previous snake_case form silently
    // dropped fields via the dual-idiom acceptor in shared/audit.ts.
    await writeAudit({
      action: 'admin.ropa_viewed',
      entityType: 'ropa',
      entityId: null,
      actorId: req.user!.sub,
      tenantId,
    } as never);

    res.json({
      data: {
        generated_at: new Date().toISOString(),
        tenant_id: tenantId,
        activities: ACTIVITY_CATALOG,
        sub_processors: subProcessors,
        operational_evidence: {
          dsar_counts: dsarCounts,
          consent_counts: consentCounts,
        },
        notes: [
          'Update apps/backend/src/modules/admin/ropa.routes.ts ACTIVITY_CATALOG when adding new processing purposes.',
          'Sub-processors maintained via /api/v1/sub-processors (ADMIN).',
          'Retention policies enforced via apps/backend/src/jobs/retentionErasure.ts (daily 03:00 UTC).',
        ],
      },
    });
  } catch (e) { next(e); }
});

ropaRouter.get('/ropa.csv', async (req, res, next) => {
  try {
    const tenantId = req.user!.tid;
    if (!req.db) throw new Error('tenantContext middleware not applied');
    // SVT-WAVE-PRIV-C2-2026-05 — include soft-deleted (removed_at != null)
    // sub-processors in the CSV so regulator review can reconstruct the
    // full processing-activity history (Art. 30(2) "Records of Processing
    // Activities" requires both active AND past processors with retirement
    // dates). The `removed_at` column distinguishes active vs retired.
    const subProcessors = await req.db.subProcessor.findMany({
      where: { tenant_id: tenantId },
      orderBy: { added_at: 'asc' },
      take: 5000,
    });

    const header = [
      'activity', 'purpose', 'lawful_basis', 'data_categories',
      'special_category', 'art9_condition', 'recipients', 'retention',
      'cross_border_transfer',
    ];
    const lines: string[] = [header.map(csvEscape).join(',')];
    for (const a of ACTIVITY_CATALOG) {
      lines.push([
        a.activity,
        a.purpose,
        a.lawful_basis,
        (a.data_categories ?? []).join('; '),
        a.special_category_data ? 'YES' : 'NO',
        (a as { art9_condition?: string }).art9_condition ?? '',
        (a.recipients ?? []).join('; '),
        a.retention,
        (a as { cross_border_transfer?: string }).cross_border_transfer ?? '',
      ].map(csvEscape).join(','));
    }
    lines.push('');
    lines.push('--- Sub-Processors (Art 28(2)) ---');
    lines.push(
      ['name', 'purpose', 'region', 'contract_url', 'dpa_signed_at', 'transfer_mechanism', 'added_at', 'removed_at', 'status']
        .map(csvEscape)
        .join(','),
    );
    for (const sp of subProcessors) {
      const spx = sp as typeof sp & { dpa_signed_at: Date | null; transfer_mechanism: string | null };
      lines.push([
        spx.name, spx.purpose, spx.region,
        spx.contract_url ?? '',
        // GDPR Art. 28 + Chapter V evidence in the register.
        spx.dpa_signed_at ? spx.dpa_signed_at.toISOString().slice(0, 10) : '',
        spx.transfer_mechanism ?? '',
        spx.added_at.toISOString().slice(0, 10),
        spx.removed_at ? spx.removed_at.toISOString().slice(0, 10) : '',
        spx.removed_at ? 'REMOVED' : 'ACTIVE',
      ].map(csvEscape).join(','));
    }

    await writeAudit({
      action: 'admin.ropa_exported',
      entityType: 'ropa',
      entityId: null,
      actorId: req.user!.sub,
      tenantId,
    } as never);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ropa-${tenantId}.csv"`);
    // Prepend UTF-8 BOM for Excel friendliness.
    res.send('﻿' + lines.join('\r\n') + '\r\n');
  } catch (e) { next(e); }
});
