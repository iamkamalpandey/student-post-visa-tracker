import { z } from 'zod';
import { PaginationQuery } from './common.js';

export const CreateSavedViewRequest = z
  .object({
    resource: z.string().min(1).max(80),
    name: z.string().min(1).max(120),
    query_json: z.record(z.string(), z.unknown()),
    is_shared: z.boolean().default(false),
  })
  .strict();
export type CreateSavedViewRequest = z.infer<typeof CreateSavedViewRequest>;

export const UpdateSavedViewRequest = CreateSavedViewRequest.partial().strict();
export type UpdateSavedViewRequest = z.infer<typeof UpdateSavedViewRequest>;

export const SavedViewListQuery = PaginationQuery.extend({
  resource: z.string().min(1).max(80).optional(),
}).strict();
export type SavedViewListQuery = z.infer<typeof SavedViewListQuery>;
