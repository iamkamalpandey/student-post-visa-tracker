// TypeScript types for the Commissions admin UI. Mirror the API row shape so
// that the Client / dialogs can share a single source of truth without
// re-defining structurally identical interfaces in each file.

import type { CommissionStatus } from '@spv/zod-schemas';

export type CommissionEnrollmentRef = {
  id: string;
  status: string;
  program: { name: string } | null;
  program_intake?: { intake_label: string | null } | null;
};

export type CommissionInstitutionRef = {
  id: string;
  display_name: string;
  country_code: string;
};

export type CommissionStudentRef = {
  id: string;
  given_name: string;
  family_name: string;
  student_code: string;
};

/** Single commission claim row as returned by `/commissions` and `/commissions/:id`. */
export type CommissionRow = {
  id: string;
  /** Optimistic-concurrency token — required by PATCH via `If-Match: "${version}"`. */
  version: number;
  status: CommissionStatus;
  /** BigInt cents on the wire — bigint when present, string from JSON.parse. */
  amount_minor: bigint | string | number;
  currency: string;
  /** Decimal as string ("12.50"). */
  commission_pct: string;
  basis_minor: bigint | string | number;
  claimed_on?: string | null;
  invoice_no?: string | null;
  invoiced_on?: string | null;
  paid_on?: string | null;
  payment_reference?: string | null;
  dispute_reason?: string | null;
  notes?: string | null;
  enrollment: CommissionEnrollmentRef;
  institution: CommissionInstitutionRef;
  student: CommissionStudentRef;
  created_at: string;
  updated_at: string;
};

export type CommissionListResponse = {
  data: CommissionRow[];
  page: { nextCursor: string | null; hasMore: boolean; total?: number };
};

/** Aggregated totals returned by `/commissions/summary`. */
export type CommissionSummaryBucket = {
  status: CommissionStatus;
  count: number;
  total_minor: bigint | string | number;
};

/**
 * SVT-FIN-2026-08 — this now mirrors what the backend actually returns.
 *
 * It previously declared `{ institution: {...}, buckets: [...] }` plus an
 * optional `totals` block, none of which the API has ever sent
 * (commissions/service.ts summary() returns flat per-status columns keyed by
 * institution_id + currency). The consequence was silent: `summary.totals` was
 * always undefined, `row.buckets ?? []` iterated an empty array for every row,
 * and all four cards in the summary strip rendered "—" no matter how much
 * commission existed.
 */
export type CommissionSummaryRow = {
  institution_id: string;
  currency: string;
  pending_count: number;
  pending_total_minor: string;
  claimed_total_minor: string;
  invoiced_total_minor: string;
  /** Cash actually received against PAID claims. */
  paid_total_minor: string;
  /** What those PAID claims were billed at — differs on short payments. */
  paid_claimed_total_minor: string;
  outstanding_total_minor: string;
};

export type CommissionSummaryResponse = {
  data: CommissionSummaryRow[];
};

export type CommissionFilters = {
  status: CommissionStatus | 'ALL';
  institution_id?: string;
  student_id?: string;
  enrollment_id?: string;
  claimed_from?: string;
  claimed_to?: string;
  paid_from?: string;
  paid_to?: string;
  page: number;
  limit: number;
};

export const COMMISSION_TABS: { value: CommissionFilters['status']; label: string }[] = [
  { value: 'ALL', label: 'All' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'CLAIMED', label: 'Claimed' },
  { value: 'INVOICED', label: 'Invoiced' },
  { value: 'PAID', label: 'Paid' },
  { value: 'DISPUTED', label: 'Disputed' },
];

// Status → MUI Chip color override (matches the brief's color map). The base
// StatusChip already maps PENDING/PAID, but the brief calls for grey on PENDING
// and a dedicated amber for INVOICED — neither of which the default map covers.
export const COMMISSION_STATUS_COLOR: Record<
  CommissionStatus,
  'default' | 'primary' | 'warning' | 'success' | 'error' | 'info'
> = {
  PENDING: 'default', // grey
  CLAIMED: 'primary', // blue
  INVOICED: 'warning', // amber
  PAID: 'success', // green
  DISPUTED: 'error', // red
  WAIVED: 'default', // muted
};
