// /expiries — triaged inbox of expiring artefacts across the data model.
//
// Sources unioned by the backend service: StudentVisa.expires_on,
// StudentIdentification.expires_on (PASSPORT only), InsuranceRecord.ends_on,
// Document.expires_on, StudentRegulatorIdentifier.expires_on. The shape below
// is what the HTTP endpoint emits — it is NOT a Prisma row.
import { z } from 'zod';

export const ExpiryKindEnum = z.enum([
  'visa',
  'passport',
  'insurance',
  'document',
  'regulator_id',
]);
export type ExpiryKind = z.infer<typeof ExpiryKindEnum>;

export const ExpirySeverityEnum = z.enum([
  'overdue',
  'critical',
  'warning',
  'ok',
]);
export type ExpiritySeverity = z.infer<typeof ExpirySeverityEnum>;

// Query parameters. `within_days` defaults to 60 (matches the dashboard widget
// horizon). `kind` is single-valued at the API layer; the FE filter strip can
// repeat the request per chip if it wants client-side multi-kind filtering, or
// rely on tab-driven filtering server-side.
export const ExpiriesListQuery = z
  .object({
    within_days: z.coerce.number().int().min(1).max(365).default(60),
    kind: ExpiryKindEnum.optional(),
  })
  .strict();
export type ExpiriesListQuery = z.infer<typeof ExpiriesListQuery>;

export const ExpiryRow = z.object({
  id: z.string(),
  kind: ExpiryKindEnum,
  student_id: z.string().uuid(),
  student_name: z.string(),
  expires_on: z.string(), // YYYY-MM-DD
  days_remaining: z.number().int(),
  severity: ExpirySeverityEnum,
  source_table: z.string(),
});
export type ExpiryRow = z.infer<typeof ExpiryRow>;
