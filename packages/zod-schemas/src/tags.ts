import { z } from 'zod';
import { PaginationQuery, Uuid } from './common.js';

const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'color_hex must be #RRGGBB');

export const CreateTagRequest = z
  .object({
    key: z
      .string()
      .min(2)
      .max(80)
      .regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/, 'lowercase slug'),
    label: z.string().min(1).max(120),
    color_hex: HexColor.optional(),
    is_active: z.boolean().default(true),
  })
  .strict();
export type CreateTagRequest = z.infer<typeof CreateTagRequest>;

export const UpdateTagRequest = CreateTagRequest.partial().strict();
export type UpdateTagRequest = z.infer<typeof UpdateTagRequest>;

// SVT-LOOKUP-FILTERS-2026-05: by default the tag picker only returns active
// tags (is_active = true). Admin tooling that needs to see archived tags
// (e.g. the management screen) passes `?include_inactive=true`.
export const TagListQuery = PaginationQuery.extend({
  include_inactive: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => v === true || v === 'true')
    .optional(),
}).strict();
export type TagListQuery = z.infer<typeof TagListQuery>;

export const CreateEntityTagRequest = z
  .object({
    tag_id: Uuid,
    entity_type: z.string().min(1).max(80),
    entity_id: Uuid,
  })
  .strict();
export type CreateEntityTagRequest = z.infer<typeof CreateEntityTagRequest>;

export const EntityTagListQuery = PaginationQuery.extend({
  entity_type: z.string().min(1).max(80).optional(),
  entity_id: Uuid.optional(),
  tag_id: Uuid.optional(),
}).strict();
export type EntityTagListQuery = z.infer<typeof EntityTagListQuery>;
