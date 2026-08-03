// SVT-V2-CRM-MIRROR-2026-06 — shared contracts for the CRM-lead mirror.
//
// Leads + their child records (applications, funnel, history, payments,
// activity, profile) are ingested read-only from V2, so the only writable
// surface is (a) SPVT-owned lead fields (spv_status / assigned_to / spv_notes)
// and (b) the post-visa fee schedule. Money is minor BigInt (serialized as a
// string over the wire by the global BigInt serializer).

import { z } from 'zod';
import { Iso8601Date, CurrencyCode, PaginationQuery, Uuid } from './common.js';
import { CreateStudentRequest } from './students.js';

// Convert a lead → managed Student. Student identity fields + an OPTIONAL app
// catalog Program to enrol the new student into (reconciliation: the lead's V2
// course is matched/picked against the curated catalog, never fabricated).
export const ConvertLeadToStudentRequest = CreateStudentRequest.extend({
  program_id: Uuid.optional(),
  // SVT-DEDUP-2026-06 — convert 409s with candidate matches when a managed
  // student with the same name + date of birth already exists (the classic
  // CRM-convert-vs-manually-added double record). Set true to acknowledge the
  // match and create a second student anyway (genuinely different person who
  // shares a name and birthday).
  acknowledge_duplicate: z.boolean().optional(),
});
export type ConvertLeadToStudentRequest = z.infer<typeof ConvertLeadToStudentRequest>;

export const CrmLeadStatusEnum = z.enum(['ACTIVE', 'COMPLETED', 'WITHDRAWN', 'ON_HOLD']);
export type CrmLeadStatus = z.infer<typeof CrmLeadStatusEnum>;

export const CrmFeeStatusEnum = z.enum(['SCHEDULED', 'DUE', 'PAID', 'WAIVED', 'OVERDUE']);
export type CrmFeeStatus = z.infer<typeof CrmFeeStatusEnum>;

export const CrmLeadCourseStateEnum = z.enum([
  'documents_collection', 'application_form', 'offer_received_unconditional',
  'offer_received_conditional', 'offer_accepted', 'offer_rejected',
  'visa_lodgement', 'visa_accepted', 'visa_refused',
]);
export type CrmLeadCourseState = z.infer<typeof CrmLeadCourseStateEnum>;

// ── Lead (SPVT-owned fields only; identity is ingest-managed) ──
export const UpdateCrmLeadRequest = z
  .object({
    spv_status: CrmLeadStatusEnum.optional(),
    assigned_to_id: Uuid.nullable().optional(),
    spv_notes: z.string().max(4000).nullable().optional(),
  })
  .strict();
export type UpdateCrmLeadRequest = z.infer<typeof UpdateCrmLeadRequest>;

// ── Fees ──
export const CreateCrmLeadFeeRequest = z
  .object({
    session_label: z.string().min(1).max(160),
    amount_minor: z.coerce.bigint().nonnegative(),
    currency: CurrencyCode,
    due_on: Iso8601Date,
    application_id: Uuid.optional(),
    notes: z.string().max(2000).optional(),
  })
  .strict();
export type CreateCrmLeadFeeRequest = z.infer<typeof CreateCrmLeadFeeRequest>;

export const UpdateCrmLeadFeeRequest = z
  .object({
    session_label: z.string().min(1).max(160).optional(),
    amount_minor: z.coerce.bigint().nonnegative().optional(),
    currency: CurrencyCode.optional(),
    due_on: Iso8601Date.optional(),
    status: CrmFeeStatusEnum.optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .strict();
export type UpdateCrmLeadFeeRequest = z.infer<typeof UpdateCrmLeadFeeRequest>;

export const MarkCrmFeePaidRequest = z
  .object({
    paid_on: Iso8601Date,
    paid_amount_minor: z.coerce.bigint().nonnegative().optional(),
  })
  .strict();
export type MarkCrmFeePaidRequest = z.infer<typeof MarkCrmFeePaidRequest>;

// ── List query ──
export const CrmLeadListQuery = PaginationQuery.extend({
  status: CrmLeadStatusEnum.optional(),
  intake_key: z.string().min(1).max(64).optional(),
  search: z.string().min(1).max(160).optional(),
  has_upcoming_fee: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => (typeof v === 'boolean' ? v : v === 'true'))
    .optional(),
  assigned_to_id: Uuid.optional(),
}).strict();
export type CrmLeadListQuery = z.infer<typeof CrmLeadListQuery>;

// ── Responses (typed for the frontend; not runtime-validated on egress) ──
export const CrmLeadFeeResponse = z.object({
  id: Uuid,
  lead_id: Uuid,
  application_id: Uuid.nullable(),
  session_label: z.string(),
  amount_minor: z.coerce.bigint(),
  currency: z.string(),
  due_on: z.string(),
  status: CrmFeeStatusEnum,
  paid_at: z.string().nullable(),
  paid_amount_minor: z.coerce.bigint().nullable(),
  notes: z.string().nullable(),
  seeded_from_v2: z.boolean(),
  version: z.number().int(),
  created_at: z.string(),
});
export type CrmLeadFeeResponse = z.infer<typeof CrmLeadFeeResponse>;

export const CrmNextFeeDue = z
  .object({
    fee_id: Uuid,
    session_label: z.string(),
    due_on: z.string(),
    amount_minor: z.coerce.bigint(),
    currency: z.string(),
    status: CrmFeeStatusEnum,
  })
  .nullable();
export type CrmNextFeeDue = z.infer<typeof CrmNextFeeDue>;

// Application pipeline query — one row per application (the real unit of work;
// a lead with N applications appears N times, each with its OWN stage).
export const CrmApplicationListQuery = PaginationQuery.extend({
  offset: z.coerce.number().int().min(0).optional(),
  stage: CrmLeadCourseStateEnum.optional(),
  intake_key: z.string().min(1).max(64).optional(),
  search: z.string().min(1).max(160).optional(),
  has_upcoming_fee: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => (typeof v === 'boolean' ? v : v === 'true'))
    .optional(),
  assigned_to_id: Uuid.optional(),
}).strict();
export type CrmApplicationListQuery = z.infer<typeof CrmApplicationListQuery>;

export const CrmApplicationListItem = z.object({
  // SVT-V2-APP-LIST-2026-08 — the post-visa work queue is now keyed to
  // crm_lead_course.state_v2='visa_accepted' (see crm-leads.service.ts
  // listApplications). A matching crm_application is enriched in when
  // present, but V2's operational reality is that most visa-accepted
  // lead_courses have no formal Application row, so intake_key +
  // application_state + next_fee_due are nullable. `id` is the
  // application id when an app matched, else the lead_course id — the
  // frontend navigates via lead_id, so callers should not treat `id` as a
  // stable application handle.
  id: Uuid,
  lead_id: Uuid,
  applicant_name: z.string(),
  phone_number: z.string(),
  country_name: z.string().nullable(),
  course_name: z.string().nullable(),
  institution_name: z.string().nullable(),
  intake_key: z.string().nullable(),
  stage: CrmLeadCourseStateEnum.nullable(), // typed funnel state (V2 stateV2 — sparsely backfilled)
  stage_raw: z.string().nullable(), // legacy free-text funnel state (V2 LeadCourses.state — well populated)
  application_state: z.string().nullable(), // V2 Application.state — null when no matching application
  spv_status: CrmLeadStatusEnum,
  assigned_to_id: Uuid.nullable(),
  created_at: z.string(),
  next_fee_due: CrmNextFeeDue.optional(),
});
export type CrmApplicationListItem = z.infer<typeof CrmApplicationListItem>;

// List row — a representative funnel/course summary + next fee.
export const CrmLeadListItem = z.object({
  id: Uuid,
  v2_lead_id: z.number().int(),
  full_name: z.string(),
  email: z.string().nullable(),
  phone_number: z.string(),
  course_name: z.string().nullable(),
  institution_name: z.string().nullable(),
  funnel_state: CrmLeadCourseStateEnum.nullable(),
  intake_key: z.string().nullable(),
  visa_accepted_at: z.string().nullable(),
  spv_status: CrmLeadStatusEnum,
  assigned_to_id: Uuid.nullable(),
  next_fee_due: CrmNextFeeDue.optional(),
});
export type CrmLeadListItem = z.infer<typeof CrmLeadListItem>;
