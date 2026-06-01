import { z } from 'zod';
import { CountryAlpha2, Iso8601Date, PaginationQuery, Uuid } from './common.js';

export const AttributeDataTypeEnum = z.enum(['text', 'number', 'date', 'bool', 'enum']);
export type AttributeDataType = z.infer<typeof AttributeDataTypeEnum>;

export const CreateAttributeDefinitionRequest = z
  .object({
    entity_type: z.string().min(1).max(80),
    key: z
      .string()
      .min(2)
      .max(80)
      .regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/, 'lowercase slug'),
    label: z.string().min(1).max(120),
    data_type: AttributeDataTypeEnum,
    enum_values: z.array(z.string().min(1)).max(200).optional(),
    is_pii: z.boolean().default(false),
    is_required: z.boolean().default(false),
    destination_country: CountryAlpha2.optional(),
  })
  .strict();
export type CreateAttributeDefinitionRequest = z.infer<typeof CreateAttributeDefinitionRequest>;

export const UpdateAttributeDefinitionRequest = CreateAttributeDefinitionRequest.partial().strict();
export type UpdateAttributeDefinitionRequest = z.infer<typeof UpdateAttributeDefinitionRequest>;

export const AttributeDefinitionListQuery = PaginationQuery.extend({
  entity_type: z.string().min(1).max(80).optional(),
}).strict();

export const CreateEntityAttributeRequest = z
  .object({
    definition_id: Uuid,
    entity_type: z.string().min(1).max(80),
    entity_id: Uuid,
    value_text: z.string().max(2000).optional(),
    value_number: z.number().optional(),
    value_date: Iso8601Date.optional(),
    value_bool: z.boolean().optional(),
  })
  .strict();
export type CreateEntityAttributeRequest = z.infer<typeof CreateEntityAttributeRequest>;

export const UpdateEntityAttributeRequest = z
  .object({
    value_text: z.string().max(2000).optional(),
    value_number: z.number().optional(),
    value_date: Iso8601Date.optional(),
    value_bool: z.boolean().optional(),
  })
  .strict();
export type UpdateEntityAttributeRequest = z.infer<typeof UpdateEntityAttributeRequest>;

export const EntityAttributeListQuery = PaginationQuery.extend({
  entity_type: z.string().min(1).max(80).optional(),
  entity_id: Uuid.optional(),
  definition_id: Uuid.optional(),
}).strict();
