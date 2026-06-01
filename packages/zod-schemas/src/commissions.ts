import { z } from 'zod';
import { Iso8601Date, PaginationQuery, Uuid } from './common.js';

// Mirrors Postgres `CommissionStatus`.
export const CommissionStatusEnum = z.enum([
  'PENDING',
  'CLAIMED',
  'INVOICED',
  'PAID',
  'DISPUTED',
  'WAIVED',
]);
export type CommissionStatus = z.infer<typeof CommissionStatusEnum>;

// Decimal-as-string so we don't lose precision on the wire. Matches Postgres
// Decimal(5,2) on commission_pct: up to three integer digits, optional 1-2 decimals.
const CommissionPctString = z
  .string()
  .regex(/^\d{1,3}(\.\d{1,2})?$/, 'commission_pct must be a decimal like "12.50"');

// ---------------------------------------------------------------------------
// List / filter
// ---------------------------------------------------------------------------

export const CommissionListQuery = PaginationQuery.extend({
  status: CommissionStatusEnum.optional(),
  institution_id: Uuid.optional(),
  student_id: Uuid.optional(),
  claimed_from: Iso8601Date.optional(),
  claimed_to: Iso8601Date.optional(),
  paid_from: Iso8601Date.optional(),
  paid_to: Iso8601Date.optional(),
}).strict();
export type CommissionListQuery = z.infer<typeof CommissionListQuery>;

// ---------------------------------------------------------------------------
// Transition request bodies
// ---------------------------------------------------------------------------

export const MarkPaidRequest = z
  .object({
    paid_on: Iso8601Date,
    payment_reference: z.string().min(1).max(120).optional(),
  })
  .strict();
export type MarkPaidRequest = z.infer<typeof MarkPaidRequest>;

export const InvoiceRequest = z
  .object({
    // If absent, the server auto-generates as `COM-YYYY-MM-NNNNNN`.
    invoice_no: z.string().min(1).max(60).optional(),
  })
  .strict();
export type InvoiceRequest = z.infer<typeof InvoiceRequest>;

export const DisputeRequest = z
  .object({
    dispute_reason: z.string().min(1).max(2000),
  })
  .strict();
export type DisputeRequest = z.infer<typeof DisputeRequest>;

// DISPUTED -> INVOICED. Optional free-text resolution note appended to the
// audit log; the body is intentionally minimal because the action itself is
// the audit-significant event.
export const ResolveDisputeRequest = z
  .object({
    resolution_notes: z.string().min(3).max(500).optional(),
  })
  .strict();
export type ResolveDisputeRequest = z.infer<typeof ResolveDisputeRequest>;

// ---------------------------------------------------------------------------
// Admin-only manual edit
// ---------------------------------------------------------------------------
// Currency / status / lifecycle dates are NOT editable via PATCH — only
// monetary correction (amount_minor / commission_pct) and free-text notes.

export const UpdateCommissionRequest = z
  .object({
    amount_minor: z.coerce.bigint().nonnegative().optional(),
    commission_pct: CommissionPctString.optional(),
    notes: z.string().max(4000).optional(),
  })
  .strict();
export type UpdateCommissionRequest = z.infer<typeof UpdateCommissionRequest>;

