import { z } from 'zod';
import { CurrencyCode, E164Phone, Email, Iso8601Date, PaginationQuery, Uuid } from './common.js';

export const AccommodationTypeEnum = z.enum([
  'UNIVERSITY_HALL',
  'HOMESTAY',
  'PRIVATE_RENTAL',
  'OWNED',
  'OTHER',
]);
export type AccommodationType = z.infer<typeof AccommodationTypeEnum>;

export const RentPeriodEnum = z.enum(['WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY']);
export type RentPeriod = z.infer<typeof RentPeriodEnum>;

export const CreateAccommodationRequest = z
  .object({
    type: AccommodationTypeEnum,
    provider_name: z.string().min(1).max(200).optional(),
    contact_phone_e164: E164Phone.optional(),
    contact_email: Email.optional(),
    address_id: Uuid.optional(),
    move_in_date: Iso8601Date.optional(),
    move_out_date: Iso8601Date.optional(),
    rent_minor: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]).optional(),
    rent_currency: CurrencyCode.optional(),
    rent_period: RentPeriodEnum.optional(),
    deposit_minor: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]).optional(),
    is_current: z.boolean().default(true),
  })
  .strict();
export type CreateAccommodationRequest = z.infer<typeof CreateAccommodationRequest>;

export const UpdateAccommodationRequest = CreateAccommodationRequest.partial().strict();
export type UpdateAccommodationRequest = z.infer<typeof UpdateAccommodationRequest>;

export const AccommodationListQuery = PaginationQuery.extend({
  type: AccommodationTypeEnum.optional(),
  is_current: z.coerce.boolean().optional(),
}).strict();
export type AccommodationListQuery = z.infer<typeof AccommodationListQuery>;
