import { z } from 'zod';
import {
  CountryAlpha2,
  E164Phone,
  Email,
  Iso8601Date,
  PaginationQuery,
  Uuid,
} from './common.js';

// ============================================================================
// Enums
// ----------------------------------------------------------------------------
// These mirror the Postgres enums on the Institution / InstitutionIdentifier
// models. Keeping the literal lists in one place lets the API surface fail
// fast on bad input before it ever reaches Prisma.
// ============================================================================

export const InstitutionTypeEnum = z.enum([
  'UNIVERSITY',
  'COLLEGE',
  'COMMUNITY_COLLEGE',
  'POLYTECHNIC',
  'LANGUAGE_SCHOOL',
  'PATHWAY_PROVIDER',
  'VOCATIONAL',
  'HIGH_SCHOOL',
  'OTHER',
]);
export type InstitutionType = z.infer<typeof InstitutionTypeEnum>;

export const InstitutionIdentifierSchemeEnum = z.enum([
  'CRICOS',
  'UKPRN',
  'OPEID',
  'DLI',
  'IPEDS',
  'PIC',
  'OTHER',
]);
export type InstitutionIdentifierScheme = z.infer<typeof InstitutionIdentifierSchemeEnum>;

// Decimal-as-string so we don't lose precision on the wire. Format is consistent
// with Postgres Decimal(5,2): up to three digits, optional 1-2 decimal places.
const CommissionPctString = z
  .string()
  .regex(/^\d{1,3}(\.\d{1,2})?$/, 'commission_pct must be a decimal like "12.50"');

// ============================================================================
// Institution
// ============================================================================

export const InstitutionBase = z
  .object({
    legal_name: z.string().min(1).max(240),
    display_name: z.string().min(1).max(240),
    short_name: z.string().min(1).max(60).optional(),
    type: InstitutionTypeEnum,
    country_code: CountryAlpha2,
    // SVT-SEC-P1-FE1-2026-05 — require http(s) scheme on the wire so XSS
    // schemes (javascript:, data:, vbscript:) can never persist to storage.
    // The FE additionally guards at render via lib/safeHref.ts for legacy rows.
    website: z
      .string()
      .url()
      .max(512)
      .refine((v) => /^https?:/i.test(v), 'Must be an http(s) URL')
      .optional(),
    email: Email.optional(),
    phone_e164: E164Phone.optional(),
    established_year: z.number().int().min(1000).max(3000).optional(),
    ranking_global: z.number().int().min(1).max(100000).optional(),
    ranking_national: z.number().int().min(1).max(100000).optional(),
    description: z.string().max(8000).optional(),
    logo_url: z.string().url().max(1024).optional(),
    banner_url: z.string().url().max(1024).optional(),
    is_partner: z.boolean().default(false),
    partner_since: Iso8601Date.optional(),
    commission_pct: CommissionPctString.optional(),
  })
  .strict();
export type InstitutionBase = z.infer<typeof InstitutionBase>;

export const CreateInstitutionRequest = InstitutionBase;
export type CreateInstitutionRequest = z.infer<typeof CreateInstitutionRequest>;

export const UpdateInstitutionRequest = InstitutionBase.partial().strict();
export type UpdateInstitutionRequest = z.infer<typeof UpdateInstitutionRequest>;

// Listing filter — bounded enums + free-text search guarded to a sane length.
export const InstitutionListQuery = PaginationQuery.extend({
  country_code: CountryAlpha2.optional(),
  is_partner: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => (typeof v === 'boolean' ? v : v === 'true'))
    .optional(),
  q: z.string().min(1).max(120).optional(),
}).strict();
export type InstitutionListQuery = z.infer<typeof InstitutionListQuery>;

// ============================================================================
// Campuses, Schools, Departments
// ============================================================================

export const CreateCampusRequest = z
  .object({
    name: z.string().min(1).max(160),
    is_main: z.boolean().optional(),
    address_id: Uuid.optional(),
    timezone: z.string().min(1).max(64).optional(),
    phone_e164: E164Phone.optional(),
    email: Email.optional(),
  })
  .strict();
export type CreateCampusRequest = z.infer<typeof CreateCampusRequest>;

export const UpdateCampusRequest = CreateCampusRequest.partial()
  .extend({ is_active: z.boolean().optional() })
  .strict();
export type UpdateCampusRequest = z.infer<typeof UpdateCampusRequest>;

export const CreateSchoolRequest = z
  .object({
    name: z.string().min(1).max(160),
    short_name: z.string().min(1).max(60).optional(),
  })
  .strict();
export type CreateSchoolRequest = z.infer<typeof CreateSchoolRequest>;

export const UpdateSchoolRequest = CreateSchoolRequest.partial()
  .extend({ is_active: z.boolean().optional() })
  .strict();
export type UpdateSchoolRequest = z.infer<typeof UpdateSchoolRequest>;

export const CreateDepartmentRequest = z
  .object({
    school_id: Uuid,
    name: z.string().min(1).max(160),
    short_name: z.string().min(1).max(60).optional(),
  })
  .strict();
export type CreateDepartmentRequest = z.infer<typeof CreateDepartmentRequest>;

export const UpdateDepartmentRequest = CreateDepartmentRequest.partial()
  .extend({ is_active: z.boolean().optional() })
  .strict();
export type UpdateDepartmentRequest = z.infer<typeof UpdateDepartmentRequest>;

// ============================================================================
// Identifiers, Accreditations, Contacts
// ============================================================================

export const CreateInstitutionIdentifierRequest = z
  .object({
    scheme: InstitutionIdentifierSchemeEnum,
    value: z.string().min(1).max(120),
    issued_by: z.string().min(1).max(240).optional(),
    valid_from: Iso8601Date.optional(),
    valid_to: Iso8601Date.optional(),
  })
  .strict();
export type CreateInstitutionIdentifierRequest = z.infer<
  typeof CreateInstitutionIdentifierRequest
>;

export const CreateInstitutionAccreditationRequest = z
  .object({
    body: z.string().min(1).max(240),
    accreditation_no: z.string().min(1).max(120).optional(),
    awarded_on: Iso8601Date.optional(),
    expires_on: Iso8601Date.optional(),
    scope: z.string().max(2000).optional(),
  })
  .strict();
export type CreateInstitutionAccreditationRequest = z.infer<
  typeof CreateInstitutionAccreditationRequest
>;

export const CreateInstitutionContactRequest = z
  .object({
    full_name: z.string().min(1).max(200),
    designation: z.string().min(1).max(160).optional(),
    department: z.string().min(1).max(160).optional(),
    email: Email.optional(),
    phone_e164: E164Phone.optional(),
    is_primary: z.boolean().optional(),
    notes: z.string().max(2000).optional(),
  })
  .strict();
export type CreateInstitutionContactRequest = z.infer<
  typeof CreateInstitutionContactRequest
>;
