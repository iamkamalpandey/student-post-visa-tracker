// SVT-WAVE-BILLING-2026-05 — Zod request/response schemas for the billing
// bounded context (FeePlan + FeeInstallment + Payment + Refund + Adjustment +
// StudentCredit).
//
// Shape conventions:
//   - Money: z.coerce.bigint().nonnegative() (mirrors finance.ts)
//   - Dates: Iso8601Date for due_on / received_on; Iso8601DateTime for refund_at
//   - All Create requests end with .strict() (reject unknown keys)
//   - Action requests are minimal — only fields the FSM transition needs

import { z } from 'zod';
import { Iso8601Date, Uuid, CurrencyCode } from './common.js';

// ---------------------------------------------------------------------------
// Shared enums (mirror Prisma)
// ---------------------------------------------------------------------------
export const BillingCadenceEnum = z.enum([
  'MONTHLY',
  'QUARTERLY',
  'TRIMESTER',
  'SEMESTER',
  'TERM',
  'ANNUAL',
  'CUSTOM',
]);
export type BillingCadenceValue = z.infer<typeof BillingCadenceEnum>;

export const FeePlanStatusEnum = z.enum([
  'DRAFT',
  'ACTIVE',
  'PAUSED',
  'COMPLETED',
  'CANCELLED',
]);
export type FeePlanStatusValue = z.infer<typeof FeePlanStatusEnum>;

export const FeeInstallmentStatusEnum = z.enum([
  'SCHEDULED',
  'INVOICED',
  'DUE',
  'OVERDUE',
  'PARTIAL',
  'PAID',
  'WAIVED',
  'SUSPENDED',
  'CANCELLED',
  'REFUNDED',
]);
export type FeeInstallmentStatusValue = z.infer<typeof FeeInstallmentStatusEnum>;

export const PaymentMethodEnum = z.enum([
  'CASH',
  'BANK_TRANSFER',
  'CARD',
  'CHEQUE',
  'OTHER',
]);
export type PaymentMethodValue = z.infer<typeof PaymentMethodEnum>;

export const PaymentStatusEnum = z.enum([
  'RECEIVED',
  'VOIDED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
]);
export type PaymentStatusValue = z.infer<typeof PaymentStatusEnum>;

export const FeeAdjustmentKindEnum = z.enum([
  'LATE_FEE',
  'DISCOUNT',
  'SCHOLARSHIP',
  'WAIVER',
  'WRITE_OFF',
]);
export type FeeAdjustmentKindValue = z.infer<typeof FeeAdjustmentKindEnum>;

export const RefundStatusEnum = z.enum(['PENDING', 'COMPLETED', 'FAILED']);
export type RefundStatusValue = z.infer<typeof RefundStatusEnum>;

// ---------------------------------------------------------------------------
// Plan creation + regeneration
// ---------------------------------------------------------------------------

/** One installment line in a custom plan (when cadence === 'CUSTOM'). */
export const FeePlanLineInput = z
  .object({
    label: z.string().min(1).max(120),
    due_on: Iso8601Date,
    gross_minor: z.coerce.bigint().nonnegative(),
  })
  .strict();
export type FeePlanLineInput = z.infer<typeof FeePlanLineInput>;

export const CreateFeePlanRequest = z
  .object({
    enrollment_id: Uuid,
    cadence: BillingCadenceEnum,
    // Cron-driven plans: total_minor + installment_count.
    total_minor: z.coerce.bigint().nonnegative().optional(),
    installment_count: z.number().int().min(1).max(120).optional(),
    starts_on: Iso8601Date,
    currency: CurrencyCode.optional(), // defaults to tenant.default_currency
    scholarship_minor: z.coerce.bigint().nonnegative().optional(),
    // Custom plans: explicit lines (overrides cadence math).
    lines: z.array(FeePlanLineInput).max(120).optional(),
    notes: z.string().max(4000).optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.cadence === 'CUSTOM'
        ? Array.isArray(v.lines) && v.lines.length > 0
        : v.total_minor != null && v.installment_count != null,
    {
      message:
        'CUSTOM cadence requires `lines[]`; cron cadences require `total_minor` + `installment_count`',
    },
  );
export type CreateFeePlanRequest = z.infer<typeof CreateFeePlanRequest>;

export const RegeneratePlanRequest = z
  .object({
    reason: z.string().min(3).max(500),
    // Optional override fields; absence = use existing plan's settings.
    cadence: BillingCadenceEnum.optional(),
    total_minor: z.coerce.bigint().nonnegative().optional(),
    installment_count: z.number().int().min(1).max(120).optional(),
    starts_on: Iso8601Date.optional(),
    lines: z.array(FeePlanLineInput).max(120).optional(),
  })
  .strict();
export type RegeneratePlanRequest = z.infer<typeof RegeneratePlanRequest>;

export const PausePlanRequest = z
  .object({
    reason: z.string().min(3).max(500),
  })
  .strict();
export type PausePlanRequest = z.infer<typeof PausePlanRequest>;

export const ResumePlanRequest = z
  .object({
    // Optional shift: push every remaining SCHEDULED/INVOICED due_on forward
    // by N days to account for the pause window. Defaults to 0 (no shift).
    shift_days: z.number().int().min(0).max(365).optional(),
  })
  .strict();
export type ResumePlanRequest = z.infer<typeof ResumePlanRequest>;

export const CancelPlanRequest = z
  .object({
    reason: z.string().min(3).max(500),
    waive_remaining: z.boolean().optional(),
  })
  .strict();
export type CancelPlanRequest = z.infer<typeof CancelPlanRequest>;

// ---------------------------------------------------------------------------
// Payments + allocations
// ---------------------------------------------------------------------------

/** Optional manual allocation: amount to apply to a specific installment. */
export const PaymentAllocationInput = z
  .object({
    fee_installment_id: Uuid,
    amount_minor: z.coerce.bigint().positive(),
  })
  .strict();
export type PaymentAllocationInput = z.infer<typeof PaymentAllocationInput>;

export const RecordPaymentRequest = z
  .object({
    enrollment_id: Uuid,
    received_on: Iso8601Date,
    method: PaymentMethodEnum,
    reference: z.string().max(200).optional(),
    currency: CurrencyCode,
    gross_minor: z.coerce.bigint().positive(),
    // When omitted, server runs FIFO over SCHEDULED|INVOICED|DUE|OVERDUE|PARTIAL.
    // When provided, sum must equal gross_minor (server-enforced).
    allocations: z.array(PaymentAllocationInput).max(120).optional(),
    notes: z.string().max(4000).optional(),
  })
  .strict();
export type RecordPaymentRequest = z.infer<typeof RecordPaymentRequest>;

export const VoidPaymentRequest = z
  .object({
    reason: z.string().min(3).max(500),
  })
  .strict();
export type VoidPaymentRequest = z.infer<typeof VoidPaymentRequest>;

// ---------------------------------------------------------------------------
// Adjustments (LATE_FEE / DISCOUNT / SCHOLARSHIP / WAIVER / WRITE_OFF)
// ---------------------------------------------------------------------------

export const ApplyAdjustmentRequest = z
  .object({
    kind: FeeAdjustmentKindEnum,
    // Convention:
    //   LATE_FEE → positive (adds to net_minor)
    //   DISCOUNT/SCHOLARSHIP/WAIVER/WRITE_OFF → negative
    // Service validates sign vs. kind to prevent admin error.
    // SVT-WAVE-BILLING-SEC-P0-F3: zero amounts are rejected at the schema
    // layer; per-kind sign + magnitude are enforced in the service.
    amount_minor: z.coerce
      .bigint()
      .refine((v) => v !== 0n, { message: 'Amount must be non-zero' }),
    reason_code: z.string().max(120).optional(),
    reason_text: z.string().min(3).max(500),
    applied_on: Iso8601Date,
  })
  .strict();
export type ApplyAdjustmentRequest = z.infer<typeof ApplyAdjustmentRequest>;

// ---------------------------------------------------------------------------
// Refunds + credit carry-forward
// ---------------------------------------------------------------------------

export const CreateRefundRequest = z
  .object({
    amount_minor: z.coerce.bigint().positive(),
    method: PaymentMethodEnum,
    reference: z.string().max(200).optional(),
    reason_code: z.string().min(1).max(120),
    reason_text: z.string().min(3).max(500),
    notes: z.string().max(4000).optional(),
  })
  .strict();
export type CreateRefundRequest = z.infer<typeof CreateRefundRequest>;

export const CompleteRefundRequest = z
  .object({
    refunded_on: Iso8601Date,
    reference: z.string().max(200).optional(),
    // If true, surplus over PaymentAllocation reversals becomes a StudentCredit
    // rather than failing. Default true (mirrors international SIS norms).
    credit_carryforward: z.boolean().optional(),
  })
  .strict();
export type CompleteRefundRequest = z.infer<typeof CompleteRefundRequest>;

// SVT-SEC-2026-05 — refund FAILED transition for payment-gateway / bank-rail
// failures. Operator surfaces the upstream error so the row stays auditable.
export const FailRefundRequest = z
  .object({
    reason: z.string().min(3).max(500),
    provider_error: z.string().max(2000).optional(),
  })
  .strict();
export type FailRefundRequest = z.infer<typeof FailRefundRequest>;

// ---------------------------------------------------------------------------
// Query schemas
// ---------------------------------------------------------------------------

export const OutstandingQuery = z
  .object({
    student_id: Uuid.optional(),
    enrollment_id: Uuid.optional(),
  })
  .strict();
export type OutstandingQuery = z.infer<typeof OutstandingQuery>;

export const FeePlanListQuery = z
  .object({
    enrollment_id: Uuid.optional(),
    student_id: Uuid.optional(),
    status: FeePlanStatusEnum.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().min(1).optional(),
  })
  .strict();
export type FeePlanListQuery = z.infer<typeof FeePlanListQuery>;

export const PaymentListQuery = z
  .object({
    student_id: Uuid.optional(),
    enrollment_id: Uuid.optional(),
    status: PaymentStatusEnum.optional(),
    from: Iso8601Date.optional(),
    to: Iso8601Date.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().min(1).optional(),
  })
  .strict();
export type PaymentListQuery = z.infer<typeof PaymentListQuery>;

// ---------------------------------------------------------------------------
// Response shapes — server payloads (no encryption, no ciphertext leaks).
// ---------------------------------------------------------------------------

export const FeeInstallmentResponse = z.object({
  id: Uuid,
  fee_plan_id: Uuid,
  sequence_no: z.number().int(),
  label: z.string(),
  due_on: z.string(), // ISO date
  gross_minor: z.coerce.bigint(),
  net_minor: z.coerce.bigint(),
  paid_minor: z.coerce.bigint(),
  balance_minor: z.coerce.bigint(),
  currency: CurrencyCode,
  status: FeeInstallmentStatusEnum,
  version: z.number().int(),
});
export type FeeInstallmentResponse = z.infer<typeof FeeInstallmentResponse>;

export const FeePlanResponse = z.object({
  id: Uuid,
  enrollment_id: Uuid,
  cadence: BillingCadenceEnum,
  total_minor: z.coerce.bigint(),
  currency: CurrencyCode,
  scholarship_minor: z.coerce.bigint(),
  status: FeePlanStatusEnum,
  starts_on: z.string(),
  ends_on: z.string().nullable(),
  paused_at: z.string().nullable(),
  paused_reason: z.string().nullable(),
  resumed_at: z.string().nullable(),
  superseded_by_id: Uuid.nullable(),
  notes: z.string().nullable(),
  version: z.number().int(),
  installments: z.array(FeeInstallmentResponse).optional(),
});
export type FeePlanResponse = z.infer<typeof FeePlanResponse>;

export const OutstandingResponse = z.object({
  total_minor: z.coerce.bigint(),
  by_status: z.record(z.string(), z.coerce.bigint()),
  oldest_due_on: z.string().nullable(),
  currency: CurrencyCode.nullable(),
});
export type OutstandingResponse = z.infer<typeof OutstandingResponse>;
