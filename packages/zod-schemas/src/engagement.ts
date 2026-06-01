import { z } from 'zod';
import { Iso8601Date, PaginationQuery, Uuid } from './common.js';

export const CreateEngagementRequest = z
  .object({
    check_date: Iso8601Date,
    method: z.string().min(1).max(80),
    present: z.boolean(),
    notes: z.string().max(2000).optional(),
    recorded_by_id: Uuid,
  })
  .strict();
export type CreateEngagementRequest = z.infer<typeof CreateEngagementRequest>;

export const UpdateEngagementRequest = CreateEngagementRequest.partial().strict();
export type UpdateEngagementRequest = z.infer<typeof UpdateEngagementRequest>;

export const EngagementListQuery = PaginationQuery.strict();
export type EngagementListQuery = z.infer<typeof EngagementListQuery>;
