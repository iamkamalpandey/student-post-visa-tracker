import { z } from 'zod';
import { Iso8601Date, PaginationQuery } from './common.js';

export const CreateRegulatorIdRequest = z
  .object({
    scheme: z.string().min(1).max(80),
    value: z.string().min(1).max(120),
    issued_on: Iso8601Date.optional(),
    expires_on: Iso8601Date.optional(),
    status: z.string().max(80).optional(),
    notes: z.string().max(2000).optional(),
  })
  .strict();
export type CreateRegulatorIdRequest = z.infer<typeof CreateRegulatorIdRequest>;

export const UpdateRegulatorIdRequest = CreateRegulatorIdRequest.partial().strict();
export type UpdateRegulatorIdRequest = z.infer<typeof UpdateRegulatorIdRequest>;

export const RegulatorIdListQuery = PaginationQuery.extend({
  scheme: z.string().min(1).max(80).optional(),
}).strict();
export type RegulatorIdListQuery = z.infer<typeof RegulatorIdListQuery>;
