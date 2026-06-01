import { z } from 'zod';
import { PaginationQuery, Uuid } from './common.js';

export const CreateNoteRequest = z
  .object({
    entity_type: z.string().min(1).max(80),
    entity_id: Uuid,
    body: z.string().min(1).max(20000),
    is_pinned: z.boolean().default(false),
  })
  .strict();
export type CreateNoteRequest = z.infer<typeof CreateNoteRequest>;

export const UpdateNoteRequest = z
  .object({
    body: z.string().min(1).max(20000).optional(),
    is_pinned: z.boolean().optional(),
  })
  .strict();
export type UpdateNoteRequest = z.infer<typeof UpdateNoteRequest>;

export const NoteListQuery = PaginationQuery.extend({
  entity_type: z.string().min(1).max(80),
  entity_id: Uuid,
}).strict();
export type NoteListQuery = z.infer<typeof NoteListQuery>;
