import { z } from 'zod';
import { CountryAlpha2, CurrencyCode, Iso8601Date, Uuid } from './common.js';

// ============================================================================
// SuperAgent — aggregator/intermediary platforms (Adventus, Edvoy, IDP,
// Apply Board, BUSY) that the consultancy uses to access institutions.
//
// One institution can be reached through multiple super-agents (m:n via
// InstitutionSuperAgent). Per Enrollment we capture which super-agent — if
// any — was used (drives commission attribution).
// ============================================================================

const SuperAgentName = z.string().min(1).max(160);
const SuperAgentShortName = z.string().min(1).max(40);
const SuperAgentNotes = z.string().max(4000);
// 0.00–100.00 with two decimal places — matches the @db.Decimal(5,2) column.
const CommissionPct = z
  .number()
  .min(0)
  .max(100)
  .multipleOf(0.01)
  // Decimal(5,2) — accept JSON numbers and stringified numbers (the DB returns
  // strings via Prisma Decimal when fetched).
  .or(z.string().regex(/^\d{1,3}(\.\d{1,2})?$/).transform((s) => Number(s)));

export const SuperAgentStatusEnum = z.enum(['ACTIVE', 'PAUSED', 'TERMINATED']);
export type SuperAgentStatus = z.infer<typeof SuperAgentStatusEnum>;

export const SuperAgentBase = z
  .object({
    type_id: Uuid.optional(),
    name: SuperAgentName,
    short_name: SuperAgentShortName.optional(),
    legal_name: z.string().min(1).max(200).optional(),
    country_code: CountryAlpha2.optional(),
    // SVT-SEC-P1-FE1-2026-05 — require http(s) scheme so XSS schemes never persist.
    website: z
      .string()
      .url()
      .max(500)
      .refine((v) => /^https?:/i.test(v), 'Must be an http(s) URL')
      .optional(),
    logo_url: z
      .string()
      .url()
      .max(500)
      .refine((v) => /^https?:/i.test(v), 'Must be an http(s) URL')
      .optional(),
    contact_email: z.string().email().max(254).optional(),
    contact_phone_e164: z.string().regex(/^\+?[1-9]\d{1,14}$/).optional(),
    default_commission_pct: CommissionPct.optional(),
    default_currency: CurrencyCode.optional(),
    payment_terms_days: z.number().int().min(0).max(365).optional(),
    status: SuperAgentStatusEnum.default('ACTIVE'),
    sub_processor_id: Uuid.optional(),
    is_active: z.boolean().default(true),
    notes: SuperAgentNotes.optional(),
  })
  .strict();
export type SuperAgentBase = z.infer<typeof SuperAgentBase>;

export const CreateSuperAgentRequest = SuperAgentBase;
export type CreateSuperAgentRequest = z.infer<typeof CreateSuperAgentRequest>;

export const UpdateSuperAgentRequest = SuperAgentBase.partial().strict();
export type UpdateSuperAgentRequest = z.infer<typeof UpdateSuperAgentRequest>;

export const SuperAgentListQuery = z
  .object({
    country_code: CountryAlpha2.optional(),
    type_id: Uuid.optional(),
    status: SuperAgentStatusEnum.optional(),
    is_active: z
      .union([z.boolean(), z.enum(['true', 'false'])])
      .transform((v) => (typeof v === 'boolean' ? v : v === 'true'))
      .optional(),
  })
  .strict();
export type SuperAgentListQuery = z.infer<typeof SuperAgentListQuery>;

// Wire row — Decimal becomes string on the wire (Prisma Decimal serialises
// to string via JSON.stringify by default).
export const SuperAgentRow = z.object({
  id: Uuid,
  tenant_id: Uuid,
  type_id: Uuid.nullable().optional(),
  name: z.string(),
  short_name: z.string().nullable().optional(),
  legal_name: z.string().nullable().optional(),
  country_code: z.string().length(2).nullable().optional(),
  website: z.string().nullable().optional(),
  logo_url: z.string().nullable().optional(),
  contact_email: z.string().nullable().optional(),
  contact_phone_e164: z.string().nullable().optional(),
  default_commission_pct: z.union([z.number(), z.string()]).nullable().optional(),
  default_currency: z.string().length(3).nullable().optional(),
  payment_terms_days: z.number().nullable().optional(),
  status: SuperAgentStatusEnum,
  is_active: z.boolean(),
  sub_processor_id: Uuid.nullable().optional(),
  notes: z.string().nullable().optional(),
  version: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable().optional(),
});
export type SuperAgentRow = z.infer<typeof SuperAgentRow>;

// ============================================================================
// SuperAgentType — admin-configurable category lookup (AGGREGATOR / REFERRAL /
// WHITE_LABEL / CONSORTIUM / GOVERNMENT, plus admin-defined extras).
// ============================================================================

export const SuperAgentTypeBase = z
  .object({
    key: z
      .string()
      .min(1)
      .max(60)
      .regex(/^[A-Z0-9_]+$/, 'key must be SCREAMING_SNAKE_CASE'),
    label: z.string().min(1).max(120),
    description: z.string().max(2000).optional(),
    is_active: z.boolean().default(true),
  })
  .strict();
export type SuperAgentTypeBase = z.infer<typeof SuperAgentTypeBase>;

export const CreateSuperAgentTypeRequest = SuperAgentTypeBase;
export type CreateSuperAgentTypeRequest = z.infer<typeof CreateSuperAgentTypeRequest>;

export const UpdateSuperAgentTypeRequest = SuperAgentTypeBase.partial().strict();
export type UpdateSuperAgentTypeRequest = z.infer<typeof UpdateSuperAgentTypeRequest>;

export const SuperAgentTypeRow = z.object({
  id: Uuid,
  tenant_id: Uuid,
  key: z.string(),
  label: z.string(),
  description: z.string().nullable().optional(),
  is_active: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type SuperAgentTypeRow = z.infer<typeof SuperAgentTypeRow>;

// ============================================================================
// SuperAgentContact — operational contacts at the super-agent.
// ============================================================================

export const SuperAgentContactBase = z
  .object({
    name: z.string().min(1).max(160),
    role: z.string().min(1).max(120).optional(),
    email: z.string().email().max(254).optional(),
    phone_e164: z.string().regex(/^\+?[1-9]\d{1,14}$/).optional(),
    is_primary: z.boolean().default(false),
    notes: z.string().max(2000).optional(),
  })
  .strict();
export type SuperAgentContactBase = z.infer<typeof SuperAgentContactBase>;

export const CreateSuperAgentContactRequest = SuperAgentContactBase;
export type CreateSuperAgentContactRequest = z.infer<typeof CreateSuperAgentContactRequest>;

export const UpdateSuperAgentContactRequest = SuperAgentContactBase.partial().strict();
export type UpdateSuperAgentContactRequest = z.infer<typeof UpdateSuperAgentContactRequest>;

export const SuperAgentContactRow = z.object({
  id: Uuid,
  tenant_id: Uuid,
  super_agent_id: Uuid,
  name: z.string(),
  role: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  phone_e164: z.string().nullable().optional(),
  is_primary: z.boolean(),
  notes: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable().optional(),
});
export type SuperAgentContactRow = z.infer<typeof SuperAgentContactRow>;

// ============================================================================
// SuperAgentCommissionRule — effective-dated commission rates with
// program-level + institution-level overrides.
// ============================================================================

export const SuperAgentCommissionRuleBase = z
  .object({
    institution_id: Uuid.optional(),
    program_level: z.string().min(1).max(60).optional(),
    commission_pct: CommissionPct,
    currency: CurrencyCode,
    effective_from: Iso8601Date,
    effective_to: Iso8601Date.optional(),
    notes: z.string().max(2000).optional(),
  })
  .strict();
export type SuperAgentCommissionRuleBase = z.infer<typeof SuperAgentCommissionRuleBase>;

export const CreateSuperAgentCommissionRuleRequest = SuperAgentCommissionRuleBase;
export type CreateSuperAgentCommissionRuleRequest = z.infer<
  typeof CreateSuperAgentCommissionRuleRequest
>;

export const UpdateSuperAgentCommissionRuleRequest = SuperAgentCommissionRuleBase.partial().strict();
export type UpdateSuperAgentCommissionRuleRequest = z.infer<
  typeof UpdateSuperAgentCommissionRuleRequest
>;

export const SuperAgentCommissionRuleRow = z.object({
  id: Uuid,
  tenant_id: Uuid,
  super_agent_id: Uuid,
  institution_id: Uuid.nullable().optional(),
  program_level: z.string().nullable().optional(),
  commission_pct: z.union([z.number(), z.string()]),
  currency: z.string().length(3),
  effective_from: z.string(),
  effective_to: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  created_at: z.string(),
});
export type SuperAgentCommissionRuleRow = z.infer<typeof SuperAgentCommissionRuleRow>;

// ============================================================================
// InstitutionSuperAgent — pivot row binding an institution ↔ super-agent.
// ============================================================================

export const CreateInstitutionSuperAgentRequest = z
  .object({
    super_agent_id: Uuid,
    commission_pct: CommissionPct.optional(),
    is_preferred: z.boolean().default(false),
    notes: z.string().max(2000).optional(),
  })
  .strict();
export type CreateInstitutionSuperAgentRequest = z.infer<
  typeof CreateInstitutionSuperAgentRequest
>;

export const UpdateInstitutionSuperAgentRequest = z
  .object({
    commission_pct: CommissionPct.nullable().optional(),
    is_preferred: z.boolean().optional(),
    notes: z.string().max(2000).optional(),
  })
  .strict();
export type UpdateInstitutionSuperAgentRequest = z.infer<
  typeof UpdateInstitutionSuperAgentRequest
>;

export const InstitutionSuperAgentRow = z.object({
  id: Uuid,
  tenant_id: Uuid,
  institution_id: Uuid,
  super_agent_id: Uuid,
  commission_pct: z.union([z.number(), z.string()]).nullable().optional(),
  is_preferred: z.boolean(),
  notes: z.string().nullable().optional(),
  created_at: z.string(),
  // Embedded super-agent summary (set by the list endpoint; optional so other
  // callers can pass minimally-populated rows through the same type).
  super_agent: z
    .object({
      id: Uuid,
      name: z.string(),
      short_name: z.string().nullable().optional(),
      is_active: z.boolean(),
      status: SuperAgentStatusEnum.optional(),
    })
    .optional(),
});
export type InstitutionSuperAgentRow = z.infer<typeof InstitutionSuperAgentRow>;

// ============================================================================
// SuperAgent metrics summary — exposed via GET /super-agents/:id/metrics.
// ============================================================================
export const SuperAgentMetricsResponse = z.object({
  super_agent_id: Uuid,
  enrollments_total: z.number().int().nonnegative(),
  enrollments_by_status: z.record(z.string(), z.number().int().nonnegative()),
  commissions_by_currency: z.record(z.string(), z.string()),
  linked_institutions: z.number().int().nonnegative(),
});
export type SuperAgentMetricsResponse = z.infer<typeof SuperAgentMetricsResponse>;
