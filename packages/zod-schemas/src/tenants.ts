import { z } from 'zod';
import { Email } from './common.js';

// SVT-WAVE17-TENANT-2026-05 — admin-editable tenant settings.
// Strict; current scope = email_from + name + legal_name + defaults. More
// fields land later as tenant onboarding grows (logo, brand_color, ...).

export const TenantSettingsResponse = z.object({
  id: z.string(),
  name: z.string(),
  legal_name: z.string().nullable(),
  default_locale: z.string(),
  default_timezone: z.string(),
  default_currency: z.string(),
  data_residency_region: z.string(),
  email_from: z.string().nullable(),
  // SVT-BILLING-TOGGLE-2026-05 — feature gate for the billing module. When
  // false the billing REST surface 404s and the FE hides the Billing tab.
  billing_enabled: z.boolean(),
});
export type TenantSettingsResponse = z.infer<typeof TenantSettingsResponse>;

export const UpdateTenantSettingsRequest = z
  .object({
    name: z.string().min(2).max(200).optional(),
    legal_name: z.string().min(2).max(200).nullable().optional(),
    default_locale: z.string().min(2).max(20).optional(),
    default_timezone: z.string().min(2).max(60).optional(),
    default_currency: z.string().length(3).optional(),
    // Validated as email; null clears + falls back to env.EMAIL_FROM.
    email_from: Email.nullable().optional(),
    // SVT-BILLING-TOGGLE-2026-05 — admins flip the billing module on/off
    // from /settings. Toggling false hides the Billing tab + blocks new
    // payments; existing FeePlans/Payments rows remain in the database.
    billing_enabled: z.boolean().optional(),
  })
  .strict();
export type UpdateTenantSettingsRequest = z.infer<typeof UpdateTenantSettingsRequest>;
