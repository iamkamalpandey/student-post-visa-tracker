import { z } from 'zod';
import { CountryAlpha2, Iso8601Date, PaginationQuery } from './common.js';

export const IdTypeEnum = z.enum([
  'PASSPORT',
  'NATIONAL_ID',
  'BIRTH_CERTIFICATE',
  'DRIVING_LICENCE',
  'OTHER',
]);
export type IdType = z.infer<typeof IdTypeEnum>;

export const CreateIdentificationRequest = z
  .object({
    type: IdTypeEnum,
    document_number: z.string().min(1).max(80),
    issuing_country: CountryAlpha2,
    issued_on: Iso8601Date,
    expires_on: Iso8601Date.optional(),
    is_primary: z.boolean().default(false),
  })
  .strict();
export type CreateIdentificationRequest = z.infer<typeof CreateIdentificationRequest>;

export const UpdateIdentificationRequest = CreateIdentificationRequest.partial().strict();
export type UpdateIdentificationRequest = z.infer<typeof UpdateIdentificationRequest>;

export const IdentificationListQuery = PaginationQuery.extend({
  type: IdTypeEnum.optional(),
}).strict();
export type IdentificationListQuery = z.infer<typeof IdentificationListQuery>;
