import { z } from 'zod';
import { Iso8601Date, PaginationQuery, Uuid } from './common.js';

export const CreateEmploymentRequest = z
  .object({
    employer_name: z.string().min(1).max(200),
    employer_address_id: Uuid.optional(),
    work_type: z.string().min(1).max(80),
    hours_per_week: z.number().int().min(0).max(168).optional(),
    started_on: Iso8601Date,
    ended_on: Iso8601Date.optional(),
    authorisation_doc_id: Uuid.optional(),
    notes: z.string().max(2000).optional(),
  })
  .strict();
export type CreateEmploymentRequest = z.infer<typeof CreateEmploymentRequest>;

export const UpdateEmploymentRequest = CreateEmploymentRequest.partial().strict();
export type UpdateEmploymentRequest = z.infer<typeof UpdateEmploymentRequest>;

export const EmploymentListQuery = PaginationQuery.strict();
export type EmploymentListQuery = z.infer<typeof EmploymentListQuery>;
