import { z } from 'zod';
import { CountryAlpha2, Iso8601Date, PaginationQuery, Uuid } from './common.js';

export const CreateDependentRequest = z
  .object({
    relationship_id: Uuid,
    given_name: z.string().min(1).max(120),
    family_name: z.string().min(1).max(120),
    date_of_birth: Iso8601Date,
    nationality_code: CountryAlpha2,
    passport_number: z.string().min(1).max(40).optional(),
    visa_status: z.string().max(80).optional(),
    accompanies_principal: z.boolean().default(true),
    notes: z.string().max(2000).optional(),
  })
  .strict();
export type CreateDependentRequest = z.infer<typeof CreateDependentRequest>;

export const UpdateDependentRequest = CreateDependentRequest.partial().strict();
export type UpdateDependentRequest = z.infer<typeof UpdateDependentRequest>;

export const DependentListQuery = PaginationQuery.strict();
export type DependentListQuery = z.infer<typeof DependentListQuery>;
