// SVT-WAVE-REPORTS-2026-05 — analytic aggregates (admin-only).
//
// Every function:
//   * runs ONE single-statement SQL aggregate via $queryRaw (no N+1)
//   * is scoped by tenant_id in the WHERE clause AND relies on the caller
//     passing the RLS-scoped req.db — defence in depth, since a misconfigured
//     app.tenant_id GUC would silently widen results
//   * returns { rows, generated_at, filters } so the FE can render
//     "Generated at HH:MM" footers and echo the filter chip values
//
// BigInt safety: *_minor totals stay as decimal strings to avoid the 2^53
// JS precision cliff. Bounded counts coerce to Number() for chart libs.

import type { Prisma, PrismaClient } from '@prisma/client';

type DB = PrismaClient | Prisma.TransactionClient;

interface ReportResult<TRow, TFilters> {
  rows: TRow[];
  generated_at: string;
  filters: TFilters;
}

const now = () => new Date().toISOString();

// 1. /reports/visa-funnel
interface VisaFunnelRow {
  stage_id: string;
  stage_key: string;
  stage_label: string;
  sequence: number;
  student_count: number;
}
interface VisaFunnelFilters { visa_type_id: string | null }

async function visaFunnel(
  db: DB,
  tenantId: string,
  filters: VisaFunnelFilters,
): Promise<ReportResult<VisaFunnelRow, VisaFunnelFilters>> {
  const raw = await db.$queryRaw<Array<{
    stage_id: string; stage_key: string; stage_label: string;
    sequence: number; student_count: bigint;
  }>>`
    SELECT s.id            AS stage_id,
           s.key           AS stage_key,
           s.label         AS stage_label,
           s.sequence,
           COUNT(st.id)    AS student_count
      FROM lifecycle_stages s
      LEFT JOIN students st
        ON st.current_stage_id = s.id
       AND st.tenant_id        = ${tenantId}::uuid
       AND st.deleted_at IS NULL
     WHERE s.tenant_id          = ${tenantId}::uuid
       AND s.show_on_dashboard  = true
       AND (${filters.visa_type_id}::uuid IS NULL OR s.visa_type_id = ${filters.visa_type_id}::uuid)
     GROUP BY s.id, s.key, s.label, s.sequence
     ORDER BY s.sequence ASC
  `;
  return {
    rows: raw.map((r) => ({ ...r, student_count: Number(r.student_count) })),
    generated_at: now(),
    filters,
  };
}

// 2. /reports/counsellor-load
interface CounsellorLoadRow {
  user_id: string | null;
  user_display_name: string | null;
  active_students: number;
  sla_breaches: number;
}
interface CounsellorLoadFilters { include_inactive_users: boolean }

async function counsellorLoad(
  db: DB,
  tenantId: string,
  filters: CounsellorLoadFilters,
): Promise<ReportResult<CounsellorLoadRow, CounsellorLoadFilters>> {
  const raw = await db.$queryRaw<Array<{
    user_id: string | null; user_display_name: string | null;
    active_students: bigint; sla_breaches: bigint;
  }>>`
    SELECT u.id                                                              AS user_id,
           COALESCE(u.display_name, u.given_name || ' ' || u.family_name)    AS user_display_name,
           COUNT(st.id)                                                      AS active_students,
           COUNT(st.id) FILTER (
             WHERE ls.sla_hours IS NOT NULL
               AND st.stage_entered_at < NOW() - (ls.sla_hours || ' hours')::interval
           )                                                                 AS sla_breaches
      FROM students st
      LEFT JOIN users u
        ON u.id        = st.assigned_to_id
       AND u.tenant_id = ${tenantId}::uuid
      LEFT JOIN lifecycle_stages ls
        ON ls.id        = st.current_stage_id
       AND ls.tenant_id = ${tenantId}::uuid
     WHERE st.tenant_id  = ${tenantId}::uuid
       AND st.deleted_at IS NULL
       AND st.status NOT IN ('COMPLETED', 'WITHDRAWN')
       AND (${filters.include_inactive_users}::boolean OR u.is_active IS NOT FALSE)
     GROUP BY u.id, u.display_name, u.given_name, u.family_name
     ORDER BY active_students DESC NULLS LAST
  `;
  return {
    rows: raw.map((r) => ({
      user_id: r.user_id, user_display_name: r.user_display_name,
      active_students: Number(r.active_students),
      sla_breaches: Number(r.sla_breaches),
    })),
    generated_at: now(),
    filters,
  };
}

// 3. /reports/commission-revenue
interface CommissionRevenueRow {
  month: string;
  status: string;
  currency: string;
  claim_count: number;
  total_amount_minor: string;
}
interface CommissionRevenueFilters { from: Date; to: Date; currency: string | null }

async function commissionRevenue(
  db: DB,
  tenantId: string,
  filters: CommissionRevenueFilters,
): Promise<ReportResult<CommissionRevenueRow, CommissionRevenueFilters>> {
  const raw = await db.$queryRaw<Array<{
    month: Date; status: string; currency: string;
    claim_count: bigint; total_amount_minor: bigint;
  }>>`
    SELECT date_trunc('month', COALESCE(cc.claimed_on, cc.created_at::date))::date AS month,
           cc.status::text                                              AS status,
           cc.currency,
           COUNT(*)                                                     AS claim_count,
           SUM(cc.amount_minor)                                         AS total_amount_minor
      FROM commission_claims cc
     WHERE cc.tenant_id = ${tenantId}::uuid
       AND cc.deleted_at IS NULL
       AND COALESCE(cc.claimed_on, cc.created_at::date) >= ${filters.from}::date
       AND COALESCE(cc.claimed_on, cc.created_at::date) <= ${filters.to}::date
       AND (${filters.currency}::char(3) IS NULL OR cc.currency = ${filters.currency}::char(3))
     GROUP BY 1, cc.status, cc.currency
     ORDER BY 1 ASC, cc.status ASC
  `;
  return {
    rows: raw.map((r) => ({
      month: r.month.toISOString().slice(0, 10),
      status: r.status, currency: r.currency,
      claim_count: Number(r.claim_count),
      total_amount_minor: r.total_amount_minor.toString(),
    })),
    generated_at: now(),
    filters,
  };
}

// 4. /reports/refund-rate
interface RefundRateRow {
  month: string;
  currency: string;
  payments_minor: string;
  refunds_minor: string;
  refund_rate: number;
}
interface RefundRateFilters { from: Date; to: Date }

async function refundRate(
  db: DB,
  tenantId: string,
  filters: RefundRateFilters,
): Promise<ReportResult<RefundRateRow, RefundRateFilters>> {
  // SVT-FIN-2026-06: group by currency too — payments/refunds of different
  // currencies must never be summed or divided together. Refunds carry no own
  // currency column, so inherit it from the parent payment via the join.
  const raw = await db.$queryRaw<Array<{
    month: Date; currency: string; payments_minor: bigint | null; refunds_minor: bigint | null; refund_rate: string | null;
  }>>`
    WITH p AS (
      SELECT date_trunc('month', received_on)::date AS month,
             currency,
             SUM(gross_minor)                       AS payments_minor
        FROM payments
       WHERE tenant_id   = ${tenantId}::uuid
         AND deleted_at IS NULL
         AND status      = 'RECEIVED'
         AND received_on BETWEEN ${filters.from}::date AND ${filters.to}::date
       GROUP BY 1, currency
    ),
    r AS (
      SELECT date_trunc('month', rf.refunded_on)::date AS month,
             pay.currency                              AS currency,
             SUM(rf.amount_minor)                      AS refunds_minor
        FROM refunds rf
        JOIN payments pay ON pay.id = rf.payment_id
       WHERE rf.tenant_id   = ${tenantId}::uuid
         AND rf.status      = 'COMPLETED'
         AND rf.refunded_on BETWEEN ${filters.from}::date AND ${filters.to}::date
       GROUP BY 1, pay.currency
    )
    SELECT COALESCE(p.month, r.month)                                       AS month,
           COALESCE(p.currency, r.currency)                                 AS currency,
           COALESCE(p.payments_minor, 0)                                    AS payments_minor,
           COALESCE(r.refunds_minor, 0)                                     AS refunds_minor,
           CASE WHEN COALESCE(p.payments_minor, 0) = 0 THEN NULL
                ELSE ROUND(COALESCE(r.refunds_minor, 0)::numeric
                           / p.payments_minor::numeric, 4)
           END                                                              AS refund_rate
      FROM p FULL OUTER JOIN r ON r.month = p.month AND r.currency = p.currency
     ORDER BY month ASC, currency ASC
  `;
  return {
    rows: raw.map((r) => ({
      month: r.month.toISOString().slice(0, 10),
      currency: r.currency,
      payments_minor: (r.payments_minor ?? 0n).toString(),
      refunds_minor: (r.refunds_minor ?? 0n).toString(),
      refund_rate: r.refund_rate == null ? 0 : Number(r.refund_rate),
    })),
    generated_at: now(),
    filters,
  };
}

// 5. /reports/outstanding-by-age
interface OutstandingByAgeRow {
  bucket: 'CURRENT' | '1_30' | '31_60' | '61_90' | '90_PLUS';
  currency: string;
  installment_count: number;
  outstanding_minor: string;
}
interface OutstandingByAgeFilters { currency: string | null }

async function outstandingByAge(
  db: DB,
  tenantId: string,
  filters: OutstandingByAgeFilters,
): Promise<ReportResult<OutstandingByAgeRow, OutstandingByAgeFilters>> {
  const raw = await db.$queryRaw<Array<{
    bucket: OutstandingByAgeRow['bucket']; currency: string;
    installment_count: bigint; outstanding_minor: bigint;
  }>>`
    SELECT CASE
             WHEN due_on >= CURRENT_DATE                          THEN 'CURRENT'
             WHEN due_on >= CURRENT_DATE - INTERVAL '30 days'     THEN '1_30'
             WHEN due_on >= CURRENT_DATE - INTERVAL '60 days'     THEN '31_60'
             WHEN due_on >= CURRENT_DATE - INTERVAL '90 days'     THEN '61_90'
             ELSE                                                       '90_PLUS'
           END                       AS bucket,
           currency,
           COUNT(*)                  AS installment_count,
           SUM(balance_minor)        AS outstanding_minor
      FROM fee_installments
     WHERE tenant_id    = ${tenantId}::uuid
       AND deleted_at IS NULL
       AND status NOT IN ('PAID', 'CANCELLED', 'REFUNDED')
       AND balance_minor > 0
       AND (${filters.currency}::char(3) IS NULL OR currency = ${filters.currency}::char(3))
     GROUP BY 1, currency
     ORDER BY currency ASC,
              CASE bucket
                WHEN 'CURRENT' THEN 0 WHEN '1_30' THEN 1 WHEN '31_60' THEN 2
                WHEN '61_90'   THEN 3 ELSE 4
              END
  `;
  return {
    rows: raw.map((r) => ({
      bucket: r.bucket, currency: r.currency,
      installment_count: Number(r.installment_count),
      outstanding_minor: r.outstanding_minor.toString(),
    })),
    generated_at: now(),
    filters,
  };
}

export const reportsService = {
  visaFunnel,
  counsellorLoad,
  commissionRevenue,
  refundRate,
  outstandingByAge,
};
