import { z } from 'zod';
import { CountryAlpha2, Uuid } from './common.js';

// ============================================================================
// VisaType — tenant-scoped catalogue of visa workflows per country.
// Used by LifecycleStage to optionally pin stages to a particular workflow
// (e.g. "Australia / sub-500 / Student Visa") while still allowing generic
// stages (visa_type_id = null) that apply across every visa type.
// ============================================================================

const VisaTypeName = z.string().min(1).max(120);
const VisaTypeShortName = z.string().min(1).max(40);
const VisaTypeDescription = z.string().max(2000);

// Strict so unknown keys fail validation rather than being silently dropped.
export const VisaTypeBase = z
  .object({
    country_code: CountryAlpha2,
    name: VisaTypeName,
    short_name: VisaTypeShortName.optional(),
    description: VisaTypeDescription.optional(),
    is_active: z.boolean().default(true),
    // is_generic marks the tenant default per country. The service layer guards
    // generic rows from rename / soft-delete so admins can't accidentally orphan
    // downstream code that relies on the "AU default" being present.
    is_generic: z.boolean().default(false),
  })
  .strict();
export type VisaTypeBase = z.infer<typeof VisaTypeBase>;

export const CreateVisaTypeRequest = VisaTypeBase;
export type CreateVisaTypeRequest = z.infer<typeof CreateVisaTypeRequest>;

// Update is a partial; admins may also flip is_active. country_code is
// intentionally re-allowed on update so the API surface stays consistent —
// the service layer prevents renaming generic rows separately.
export const UpdateVisaTypeRequest = VisaTypeBase.partial().strict();
export type UpdateVisaTypeRequest = z.infer<typeof UpdateVisaTypeRequest>;

// Listing filter — both filters are optional and AND together. is_active is
// coerced from string queries since `?is_active=true` arrives as a string.
export const VisaTypeListQuery = z
  .object({
    country_code: CountryAlpha2.optional(),
    is_active: z
      .union([z.boolean(), z.enum(['true', 'false'])])
      .transform((v) => (typeof v === 'boolean' ? v : v === 'true'))
      .optional(),
  })
  .strict();
export type VisaTypeListQuery = z.infer<typeof VisaTypeListQuery>;

// Server-shaped row returned by GET /visa-types. Mirrors the Prisma VisaType
// model with timestamps as ISO strings on the wire.
export const VisaTypeRow = z.object({
  id: Uuid,
  tenant_id: Uuid,
  country_code: z.string().length(2),
  name: z.string(),
  short_name: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  is_active: z.boolean(),
  is_generic: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable().optional(),
});
export type VisaTypeRow = z.infer<typeof VisaTypeRow>;
