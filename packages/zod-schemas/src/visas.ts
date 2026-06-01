import { z } from 'zod';
import { CountryAlpha2, Iso8601Date, PaginationQuery, Uuid } from './common.js';

export const VisaEntriesEnum = z.enum(['SINGLE', 'DOUBLE', 'MULTIPLE']);
export type VisaEntries = z.infer<typeof VisaEntriesEnum>;

export const CreateVisaRequest = z
  .object({
    visa_category_id: Uuid,
    visa_number: z.string().min(1).max(80),
    destination_country: CountryAlpha2,
    issuing_post: z.string().max(120).optional(),
    issued_on: Iso8601Date,
    expires_on: Iso8601Date,
    entries: VisaEntriesEnum.default('MULTIPLE'),
    conditions: z.string().max(2000).optional(),
    is_active: z.boolean().default(true),
  })
  .strict();
export type CreateVisaRequest = z.infer<typeof CreateVisaRequest>;

export const UpdateVisaRequest = CreateVisaRequest.partial().strict();
export type UpdateVisaRequest = z.infer<typeof UpdateVisaRequest>;

export const VisaListQuery = PaginationQuery.extend({
  is_active: z.coerce.boolean().optional(),
}).strict();
export type VisaListQuery = z.infer<typeof VisaListQuery>;
