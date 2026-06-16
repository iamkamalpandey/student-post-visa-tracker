import { z } from 'zod';
import {
  CountryAlpha2,
  E164Phone,
  Email,
  Iso8601Date,
  Iso8601DateTime,
  PaginationQuery,
  Uuid,
} from './common.js';

// Mirrors the Postgres `Gender` enum on the Student model.
export const GenderEnum = z.enum(['NOT_KNOWN', 'MALE', 'FEMALE', 'NOT_APPLICABLE']);
export type Gender = z.infer<typeof GenderEnum>;

// Mirrors the Postgres `MaritalStatus` enum.
// Marital status — covers UK Civil Partnership Act 2004, EU/AU/NZ legal forms,
// and the UN/OECD "Separated" classification. Backed by Prisma `MaritalStatus`.
export const MaritalStatusEnum = z.enum([
  'SINGLE',
  'MARRIED',
  'CIVIL_PARTNERSHIP',
  'SEPARATED',
  'DIVORCED',
  'WIDOWED',
  'OTHER',
]);
export type MaritalStatus = z.infer<typeof MaritalStatusEnum>;

// Mirrors the Postgres `StudentStatus` enum.
export const StudentStatusEnum = z.enum([
  'ACTIVE',
  'ON_HOLD',
  'WITHDRAWN',
  'COMPLETED',
  'DEFERRED',
]);
export type StudentStatus = z.infer<typeof StudentStatusEnum>;

// Strict base used by both create and update (with `.partial()` for update).
// We keep optional vs required boundaries explicit so the create variant can hard-require
// the legally-significant fields (name in passport, DOB, nationality).
//
// Name regex: must start with a Unicode letter; subsequent chars allow letter, combining
// mark, hyphen, apostrophe, period, space. Rejects pure digits / pure symbols. Supports
// non-Latin scripts (Devanagari, Arabic, CJK, etc.).
const NameField = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[\p{L}][\p{L}\p{M}'\-.\s]*$/u, 'Use letters only — digits and symbols are not allowed in names');

const PassportNameField = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[\p{L}][\p{L}\p{M}'\-.\s]*$/u, 'Use letters only — digits and symbols are not allowed in passport name');

export const StudentBase = z
  .object({
    given_name: NameField,
    middle_name: NameField.optional(),
    family_name: NameField,
    preferred_name: NameField.optional(),
    name_in_passport: PassportNameField,
    date_of_birth: Iso8601Date,
    gender: GenderEnum,
    gender_self_described: z.string().min(1).max(120).optional(),
    nationality_code: CountryAlpha2,
    marital_status: MaritalStatusEnum.optional(),
    // ISO 639-1 alpha-2 language code (e.g. en, ne, hi) — enforce 2 letters,
    // not any 2 chars, so "12"/"n1" can't persist.
    primary_language: z.string().length(2).regex(/^[A-Za-z]{2}$/, 'must be an ISO 639-1 alpha-2 language code'),
    // Self-declared identity fields. Free text by design — closed enums are culturally
    // fraught for these. Optional everywhere.
    religion: z.string().min(1).max(80).optional(),
    ethnicity: z.string().min(1).max(80).optional(),
    email_primary: Email.optional(),
    email_secondary: Email.optional(),
    phone_primary_e164: E164Phone.optional(),
    phone_secondary_e164: E164Phone.optional(),
    notes: z.string().max(4000).optional(),
  })
  .strict();
export type StudentBase = z.infer<typeof StudentBase>;

// Create requires all the fields above. The optional knobs add an initial stage assignment
// (else the service falls back to the LifecycleStage with is_initial = true) and an
// assigned counsellor / status override.
export const CreateStudentRequest = StudentBase.extend({
  current_stage_id: Uuid.optional(),
  assigned_to_id: Uuid.optional(),
  status: StudentStatusEnum.optional(),
}).strict();
export type CreateStudentRequest = z.infer<typeof CreateStudentRequest>;

// PATCH semantics: any subset of base fields, plus the operational overrides.
export const UpdateStudentRequest = StudentBase.partial()
  .extend({
    status: StudentStatusEnum.optional(),
    assigned_to_id: Uuid.optional(),
  })
  .strict();
export type UpdateStudentRequest = z.infer<typeof UpdateStudentRequest>;

// Sort tokens are constrained to an allow-list to keep the SQL ORDER BY safe.
const STUDENT_SORT_REGEX =
  /^-?(family_name|given_name|created_at|updated_at|stage_entered_at)(,-?(family_name|given_name|created_at|updated_at|stage_entered_at))*$/;

export const StudentListQuery = PaginationQuery.extend({
  stage_id: Uuid.optional(),
  status: StudentStatusEnum.optional(),
  assigned_to_id: Uuid.optional(),
  search: z.string().min(1).max(120).optional(),
  sort: z.string().regex(STUDENT_SORT_REGEX).optional(),
  // SVT-WAVE39-STUDENT-SLA-FILTER-2026-05 — when true, list only students
  // whose elapsed-in-stage time exceeds the current stage's sla_hours.
  // Implemented server-side via OR clauses across SLA-bearing stages.
  sla_breached: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .optional()
    .transform((v) => (v === true || v === 'true' ? true : undefined)),
}).strict();
export type StudentListQuery = z.infer<typeof StudentListQuery>;

// Stage advance request body. effective_at is optional so the service can default to now().
//
// v6: prompt_date_value is captured by the FE when the destination stage has a
// `prompt_date_label` set (e.g. "Departed on", "Arrived on"). It's stored on
// the StudentLifecycleEvent.metadata as `prompt_date` for downstream reporting.
export const AdvanceStageRequest = z
  .object({
    to_stage_id: Uuid,
    effective_at: Iso8601DateTime.optional(),
    // SVT-LIFECYCLE-2026-05: reason_code stays optional at the schema layer
    // because forward / lateral moves don't require one. The students service
    // enforces required-when-backward (>=3 chars) at runtime so the wire
    // shape doesn't break for forward callers.
    reason_code: z.string().min(3).max(120).optional(),
    notes: z.string().max(2000).optional(),
    prompt_date_value: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected ISO 8601 date (YYYY-MM-DD)')
      .optional(),
    // SVT-WAVE-BILLING-SEC-P0-F2: admin-only override that permits a stage
    // skip greater than +1 under the default-open matrix. The service
    // refuses to honour `force` from a non-ADMIN role. Forwarded by the
    // controller from req.query.force=true OR req.body.force=true so both
    // conventions are supported (UI typically sends a query flag).
    force: z.boolean().optional(),
  })
  .strict();
export type AdvanceStageRequest = z.infer<typeof AdvanceStageRequest>;
