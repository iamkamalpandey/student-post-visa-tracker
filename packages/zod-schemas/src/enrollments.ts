import { z } from 'zod';
import { CurrencyCode, Iso8601Date, PaginationQuery, Uuid } from './common.js';

// Mirrors Postgres `EnrollmentStatus`.
export const EnrollmentStatusEnum = z.enum([
  'OFFERED',
  'ACCEPTED',
  'ENROLLED',
  'DEFERRED',
  'WITHDRAWN',
  'COMPLETED',
  'CANCELLED',
]);
export type EnrollmentStatus = z.infer<typeof EnrollmentStatusEnum>;

export const CreateEnrollmentRequest = z
  .object({
    institution_id: Uuid,
    program_id: Uuid,
    program_intake_id: Uuid.optional(),
    campus_id: Uuid.optional(),
    enrollment_no: z.string().min(1).max(80).optional(),
    start_date: Iso8601Date.optional(),
    expected_end_date: Iso8601Date.optional(),
    actual_end_date: Iso8601Date.optional(),
    status: EnrollmentStatusEnum.default('OFFERED'),
    tuition_total_minor: z.coerce.bigint().nonnegative().optional(),
    tuition_currency: CurrencyCode.optional(),
    scholarship_minor: z.coerce.bigint().nonnegative().default(0n),
    scholarship_name: z.string().min(1).max(160).optional(),
    agent_commission_minor: z.coerce.bigint().nonnegative().optional(),
    // Optional super-agent (intermediary aggregator). null/omitted = direct
    // enrollment, no super-agent involved. The link to the institution is
    // verified server-side against institution_super_agents.
    super_agent_id: Uuid.nullable().optional(),
    notes: z.string().max(4000).optional(),
  })
  .strict();
export type CreateEnrollmentRequest = z.infer<typeof CreateEnrollmentRequest>;

// PATCH may carry a `reason_code` to satisfy FSM transitions that require one
// (e.g. ACCEPTED → WITHDRAWN, COMPLETED → ENROLLED rollback). Optional because
// non-status edits and reason-free transitions don't need it. ADMIN may also
// pass `allow_locked_field_edit: true` to override the tuition lock that
// fires when the linked CommissionClaim is INVOICED/PAID.
export const UpdateEnrollmentRequest = CreateEnrollmentRequest.partial()
  .extend({
    reason_code: z.string().min(3).max(120).optional(),
    allow_locked_field_edit: z.boolean().optional(),
  })
  .strict();
export type UpdateEnrollmentRequest = z.infer<typeof UpdateEnrollmentRequest>;

export const EnrollmentListQuery = PaginationQuery.extend({
  student_id: Uuid.optional(),
  institution_id: Uuid.optional(),
  program_id: Uuid.optional(),
  status: EnrollmentStatusEnum.optional(),
}).strict();
export type EnrollmentListQuery = z.infer<typeof EnrollmentListQuery>;
