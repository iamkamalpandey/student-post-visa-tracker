// SVT-WAVE-BILLING-2026-05 — FE billing query + mutation hooks.
//
// Maps to the Wave 4 backend (apps/backend/src/modules/billing/billing.routes.ts):
//   GET    /billing/plans                       → list
//   GET    /billing/plans/:id                   → detail + installments
//   POST   /billing/plans                       → create (idempotent)
//   POST   /billing/plans/:id/{pause|resume|cancel|regenerate}
//   GET    /billing/payments                    → list
//   GET    /billing/payments/:id                → detail + allocations + refunds
//   POST   /billing/payments                    → record
//   POST   /billing/payments/:id/void
//   POST   /billing/payments/:id/refunds        → create refund (PENDING)
//   POST   /billing/refunds/:id/{complete|fail}
//   POST   /billing/installments/:id/adjustments → apply
//   GET    /billing/outstanding                 → aggregate
//
// All endpoints gated server-side by Tenant.billing_enabled (404 when off).
// `useBillingEnabled()` reads tenant.billing_enabled from /tenants/me — the
// canonical source of truth for the flag. Earlier revisions probed
// /billing/plans?limit=1 and treated 404 as "off", which generated noisy
// 404s in every page load and double-fetched data the AppShell already had.

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useTenant } from '../../lib/queries';

// ---------------------------------------------------------------------------
// Types — mirror @spv/zod-schemas/billing but kept local to avoid a hard
// dep on the package's API surface for non-billing pages.
// ---------------------------------------------------------------------------
export type FeePlanStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';
export type FeeInstallmentStatus =
  | 'SCHEDULED' | 'INVOICED' | 'DUE' | 'OVERDUE' | 'PARTIAL' | 'PAID'
  | 'WAIVED' | 'SUSPENDED' | 'CANCELLED' | 'REFUNDED';
export type PaymentStatus = 'RECEIVED' | 'VOIDED' | 'PARTIALLY_REFUNDED' | 'REFUNDED';
export type PaymentMethod = 'CASH' | 'BANK_TRANSFER' | 'CARD' | 'CHEQUE' | 'OTHER';
export type RefundStatus = 'PENDING' | 'COMPLETED' | 'FAILED';
export type BillingCadence =
  | 'MONTHLY' | 'QUARTERLY' | 'TRIMESTER' | 'SEMESTER' | 'TERM' | 'ANNUAL' | 'CUSTOM';
export type FeeAdjustmentKind =
  | 'LATE_FEE' | 'DISCOUNT' | 'SCHOLARSHIP' | 'WAIVER' | 'WRITE_OFF';

export type FeeInstallment = {
  id: string;
  fee_plan_id: string;
  sequence_no: number;
  label: string;
  due_on: string;
  gross_minor: string; // bigint as string over the wire
  net_minor: string;
  paid_minor: string;
  balance_minor: string;
  currency: string;
  status: FeeInstallmentStatus;
  version: number;
};

export type FeePlan = {
  id: string;
  enrollment_id: string;
  cadence: BillingCadence;
  total_minor: string;
  currency: string;
  scholarship_minor: string;
  status: FeePlanStatus;
  starts_on: string;
  ends_on: string | null;
  paused_at: string | null;
  paused_reason: string | null;
  resumed_at: string | null;
  superseded_by_id: string | null;
  notes: string | null;
  version: number;
  installments?: FeeInstallment[];
};

export type Payment = {
  id: string;
  receipt_no: string;
  received_on: string;
  method: PaymentMethod;
  currency: string;
  gross_minor: string;
  status: PaymentStatus;
  reference?: string | null;
  notes?: string | null;
  allocations?: Array<{ id?: string; fee_installment_id: string; amount_minor: string }>;
  refunds?: Refund[];
};

export type Refund = {
  id: string;
  payment_id: string;
  amount_minor: string;
  method: PaymentMethod;
  reason_code: string;
  reason_text: string;
  reference?: string | null;
  notes?: string | null;
  status: RefundStatus;
  refunded_on?: string | null;
  created_at?: string;
};

// SVT-QA-2026-08 — per-currency breakdown. NEVER net across currencies.
// A student with a USD enrollment + a GBP enrollment gets two entries. The
// PlanSummaryCard is scoped per enrollment so typically returns one entry,
// but the tenant-wide dashboard uses the same endpoint and MUST render one
// tile-set per currency.
export type OutstandingCurrencyBucket = {
  currency: string;
  total_minor: string;
  by_status: Record<string, string>;
  oldest_due_on: string | null;
};
export type Outstanding = {
  by_currency: OutstandingCurrencyBucket[];
};

// ---------------------------------------------------------------------------
// Feature gate
// ---------------------------------------------------------------------------
// Re-projects `useTenant()` as a UseQueryResult<boolean> so call sites that
// previously branched on `.isLoading` / `.data === true` keep working. We
// piggyback on the same TanStack cache entry (['tenants', 'me']) — that
// means flipping the toggle in /settings invalidates this hook for free,
// without a second network round-trip the old 404 probe used to require.
export function useBillingEnabled(): UseQueryResult<boolean> {
  const tenant = useTenant();
  // Cast through the underlying query result: the only field consumers read
  // is `data` (boolean) plus loading/error pass-throughs. The transform is a
  // cheap projection rather than a separate useQuery to avoid cache drift.
  // We need `unknown` here because TanStack's discriminated-union result types
  // can't see that swapping `data`'s type still satisfies the union.
  return {
    ...tenant,
    data: tenant.data ? tenant.data.billing_enabled === true : undefined,
  } as unknown as UseQueryResult<boolean>;
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------
export function useFeePlans(q: { enrollment_id?: string; student_id?: string; status?: FeePlanStatus; limit?: number }): UseQueryResult<{ data: FeePlan[]; page: { total: number } }> {
  return useQuery({
    queryKey: ['billing', 'plans', q],
    queryFn: async () => {
      const res = await api.get('/billing/plans', { params: q });
      return res.data as { data: FeePlan[]; page: { total: number } };
    },
    enabled: Boolean(q.enrollment_id ?? q.student_id ?? q.status),
    staleTime: 30_000,
  });
}

export function useFeePlan(planId: string | null): UseQueryResult<FeePlan> {
  return useQuery({
    queryKey: ['billing', 'plan', planId],
    queryFn: async () => {
      const res = await api.get(`/billing/plans/${planId}`);
      return (res.data as { data: FeePlan }).data;
    },
    enabled: Boolean(planId),
    staleTime: 30_000,
  });
}

export function useOutstanding(q: { student_id?: string; enrollment_id?: string }): UseQueryResult<Outstanding> {
  return useQuery({
    queryKey: ['billing', 'outstanding', q],
    queryFn: async () => {
      const res = await api.get('/billing/outstanding', { params: q });
      return (res.data as { data: Outstanding }).data;
    },
    enabled: Boolean(q.student_id ?? q.enrollment_id),
    staleTime: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------
export function usePayments(q: { student_id?: string; enrollment_id?: string; status?: PaymentStatus; from?: string; to?: string; limit?: number }): UseQueryResult<{ data: Payment[]; page: { total: number } }> {
  return useQuery({
    queryKey: ['billing', 'payments', q],
    queryFn: async () => {
      const res = await api.get('/billing/payments', { params: q });
      return res.data as { data: Payment[]; page: { total: number } };
    },
    enabled: Boolean(q.student_id ?? q.enrollment_id),
    staleTime: 30_000,
  });
}

/**
 * Single payment detail (allocations + refunds). Used by the refund queue's
 * "Complete refund" action to look up the active PENDING refund id, since the
 * list endpoint does not embed the refunds[] collection.
 */
export function usePaymentDetail(paymentId: string | null): UseQueryResult<Payment> {
  return useQuery({
    queryKey: ['billing', 'payment', paymentId],
    queryFn: async () => {
      const res = await api.get(`/billing/payments/${paymentId}`);
      return (res.data as { data: Payment }).data;
    },
    enabled: Boolean(paymentId),
    staleTime: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Admin /billing page hooks — tenant-wide reads.
//
// Distinct from `usePayments` (which is gated on a student/enrollment id so it
// doesn't fire on contextless mounts). Each of these is unconditionally enabled
// and uses a 60s staleTime — these are dashboards, not live tickers.
// ---------------------------------------------------------------------------

const ADMIN_STALE_MS = 60_000;

export type FinanceSummaryCurrencyRow = {
  currency: string;
  total_outstanding_minor: string;
  collections_30d_minor: string;
  refunds_30d_minor: string;
  refund_rate_30d: number;
};
export type FinanceSummary = {
  /** Per-currency money rows — NEVER netted across currencies. */
  by_currency: FinanceSummaryCurrencyRow[];
  overdue_count: number;
  active_plans_count: number;
};

export type AgedDebtBucket = 'CURRENT' | '1_30' | '31_60' | '61_90' | '90_PLUS';

export type AgedDebtRow = {
  bucket: AgedDebtBucket;
  currency: string;
  installment_count: number;
  outstanding_minor: string;
};

export type AgedDebtResponse = {
  rows: AgedDebtRow[];
  generated_at: string;
  filters: { currency: string | null };
};

/** Tenant-wide finance KPIs — Outstanding, Overdue count, Collections, Refund rate, Active plans. */
export function useFinanceSummary(enabled = true): UseQueryResult<FinanceSummary> {
  return useQuery({
    queryKey: ['billing', 'finance-summary'],
    enabled,
    queryFn: async () => {
      const res = await api.get('/dashboard/finance-summary');
      return (res.data as { data: FinanceSummary }).data;
    },
    staleTime: ADMIN_STALE_MS,
  });
}

/** Outstanding installments bucketed by age (CURRENT / 1-30 / 31-60 / 61-90 / 90+). Admin only. */
export function useAgedDebt(enabled = true): UseQueryResult<AgedDebtResponse> {
  return useQuery({
    queryKey: ['billing', 'aged-debt'],
    enabled,
    queryFn: async () => {
      const res = await api.get('/reports/outstanding-by-age');
      return res.data as AgedDebtResponse;
    },
    staleTime: ADMIN_STALE_MS,
  });
}

/**
 * Tenant-wide payment list — unlike `usePayments`, fires without a
 * student/enrollment scope. Used by the admin /billing page (today's receipts
 * + refund queue tabs).
 */
export function useAdminPayments(
  q: { status?: PaymentStatus; from?: string; to?: string; limit?: number },
  enabled = true,
): UseQueryResult<{ data: Payment[]; page: { total: number } }> {
  return useQuery({
    queryKey: ['billing', 'admin-payments', q],
    enabled,
    queryFn: async () => {
      const res = await api.get('/billing/payments', { params: q });
      return res.data as { data: Payment[]; page: { total: number } };
    },
    staleTime: ADMIN_STALE_MS,
  });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

// SVT-SEC-MFA-STEPUP-2026-05 — sensitive billing mutations accept an optional
// `mfa_code`. When present we forward it as `X-MFA-Code` for the backend's
// requireMfa middleware. The FE flow is: try without code → backend may 401
// with `code: 'mfa_required'` → caller prompts inline → retry WITH the code.
function mfaHeaders(code?: string): { headers?: Record<string, string> } {
  return code ? { headers: { 'X-MFA-Code': code } } : {};
}

export function useRecordPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      enrollment_id: string;
      received_on: string;
      method: PaymentMethod;
      currency: string;
      gross_minor: string;
      reference?: string;
      notes?: string;
      allocations?: Array<{ fee_installment_id: string; amount_minor: string }>;
    }) => {
      const res = await api.post('/billing/payments', input);
      return res.data as Payment;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['billing', 'payments'] });
      qc.invalidateQueries({ queryKey: ['billing', 'outstanding'] });
      qc.invalidateQueries({ queryKey: ['billing', 'plans', { enrollment_id: vars.enrollment_id }] });
      qc.invalidateQueries({ queryKey: ['billing', 'plan'] });
    },
  });
}

export function useCreateFeePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      enrollment_id: string;
      cadence: BillingCadence;
      total_minor?: string;
      installment_count?: number;
      starts_on: string;
      currency?: string;
      scholarship_minor?: string;
      lines?: Array<{ label: string; due_on: string; gross_minor: string }>;
      notes?: string;
    }) => {
      const res = await api.post('/billing/plans', input);
      return res.data as FeePlan;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['billing', 'plans'] });
      qc.invalidateQueries({ queryKey: ['billing', 'outstanding'] });
    },
  });
}

export function usePauseFeePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { id: string; reason: string }) => {
      const res = await api.post(`/billing/plans/${vars.id}/pause`, { reason: vars.reason });
      return res.data as FeePlan;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['billing'] }),
  });
}

export function useResumeFeePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { id: string; shift_days?: number }) => {
      const res = await api.post(`/billing/plans/${vars.id}/resume`, { shift_days: vars.shift_days });
      return res.data as FeePlan;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['billing'] }),
  });
}

export function useCancelFeePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { id: string; reason: string; waive_remaining?: boolean; mfa_code?: string }) => {
      const res = await api.post(
        `/billing/plans/${vars.id}/cancel`,
        { reason: vars.reason, waive_remaining: vars.waive_remaining },
        mfaHeaders(vars.mfa_code),
      );
      return res.data as FeePlan;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['billing'] }),
  });
}

export function useVoidPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { id: string; reason: string; mfa_code?: string }) => {
      const res = await api.post(
        `/billing/payments/${vars.id}/void`,
        { reason: vars.reason },
        mfaHeaders(vars.mfa_code),
      );
      return res.data as Payment;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['billing'] }),
  });
}

export function useCreateRefund() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      payment_id: string;
      amount_minor: string;
      method: PaymentMethod;
      reason_code: string;
      reason_text: string;
      reference?: string;
      notes?: string;
      mfa_code?: string;
    }) => {
      const { payment_id, mfa_code, ...body } = vars;
      const res = await api.post(
        `/billing/payments/${payment_id}/refunds`,
        body,
        mfaHeaders(mfa_code),
      );
      return res.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['billing'] }),
  });
}

export function useCompleteRefund() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      id: string;
      refunded_on: string;
      reference?: string;
      credit_carryforward?: boolean;
      mfa_code?: string;
    }) => {
      const { id, mfa_code, ...body } = vars;
      const res = await api.post(
        `/billing/refunds/${id}/complete`,
        body,
        mfaHeaders(mfa_code),
      );
      return res.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['billing'] }),
  });
}

// SVT-WAVE-BILLING-2026-05 — companion to useCompleteRefund for the FAILED
// transition (gateway/bank-rail rejection). Backend route is unauthenticated
// for MFA (provider failures must be reportable from on-call without TOTP),
// but the hook still accepts an optional `mfa_code` to mirror the sibling
// shape — passed through as X-MFA-Code if requireMfa is ever added.
export function useFailRefund() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      id: string;
      reason: string;
      provider_error?: string;
      mfa_code?: string;
    }) => {
      const { id, mfa_code, ...body } = vars;
      const res = await api.post(
        `/billing/refunds/${id}/fail`,
        body,
        mfaHeaders(mfa_code),
      );
      return res.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['billing'] }),
  });
}

export function useApplyAdjustment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      installment_id: string;
      kind: FeeAdjustmentKind;
      amount_minor: string;
      reason_text: string;
      reason_code?: string;
      applied_on: string;
    }) => {
      const { installment_id, ...body } = vars;
      const res = await api.post(`/billing/installments/${installment_id}/adjustments`, body);
      return res.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['billing'] }),
  });
}
