import { z } from 'zod';
import { CountryAlpha2, CurrencyCode, E164Phone, Email, Iso8601Date, PaginationQuery, Uuid } from './common.js';

export const SponsorTypeEnum = z.enum([
  'INDIVIDUAL',
  'FAMILY',
  'EMPLOYER',
  'GOVERNMENT',
  'INSTITUTION',
  'CHARITY',
  'OTHER',
]);
export type SponsorType = z.infer<typeof SponsorTypeEnum>;

export const CreateSponsorRequest = z
  .object({
    type: SponsorTypeEnum,
    legal_name: z.string().min(1).max(200),
    registration_no: z.string().max(80).optional(),
    country_code: CountryAlpha2.optional(),
    email: Email.optional(),
    phone_e164: E164Phone.optional(),
    address_id: Uuid.optional(),
    is_active: z.boolean().default(true),
  })
  .strict();
export type CreateSponsorRequest = z.infer<typeof CreateSponsorRequest>;

export const UpdateSponsorRequest = CreateSponsorRequest.partial().strict();
export type UpdateSponsorRequest = z.infer<typeof UpdateSponsorRequest>;

const Money = z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]);

export const CreateSponsorshipRequest = z
  .object({
    sponsor_id: Uuid,
    coverage_pct: z.number().min(0).max(100),
    amount_minor: Money.optional(),
    currency: CurrencyCode.optional(),
    starts_on: Iso8601Date.optional(),
    ends_on: Iso8601Date.optional(),
    letter_doc_id: Uuid.optional(),
    notes: z.string().max(2000).optional(),
  })
  .strict();
export type CreateSponsorshipRequest = z.infer<typeof CreateSponsorshipRequest>;

export const UpdateSponsorshipRequest = CreateSponsorshipRequest.partial().strict();
export type UpdateSponsorshipRequest = z.infer<typeof UpdateSponsorshipRequest>;

export const SponsorListQuery = PaginationQuery.extend({
  type: SponsorTypeEnum.optional(),
}).strict();
export type SponsorListQuery = z.infer<typeof SponsorListQuery>;

export const SponsorshipListQuery = PaginationQuery.strict();
export type SponsorshipListQuery = z.infer<typeof SponsorshipListQuery>;
