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

export type CommissionSummaryRow = {
  institution: CommissionInstitutionRef;
  currency: string;
  buckets: CommissionSummaryBucket[];
};

export type CommissionSummaryResponse = {
  data: CommissionSummaryRow[];
  /** Headline totals — keyed by status for the 4-card strip. */
  totals?: Partial<Record<CommissionStatus, { total_minor: bigint | string | number; currency: string }>>;
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
