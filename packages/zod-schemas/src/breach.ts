import { z } from 'zod';
import { Iso8601DateTime, PaginationQuery } from './common.js';

export const SeverityEnum = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

export const CreateBreachRequest = z
  .object({
    detected_at: Iso8601DateTime,
    reported_at: Iso8601DateTime.optional(),
    severity: SeverityEnum,
    affected_subjects_count: z.number().int().min(0).optional(),
    description: z.string().min(1).max(5000),
    remediation: z.string().max(5000).optional(),
    notification_sent: z.boolean().default(false),
  })
  .strict();
export type CreateBreachRequest = z.infer<typeof CreateBreachRequest>;

export const UpdateBreachRequest = CreateBreachRequest.partial()
  .extend({ closed_at: Iso8601DateTime.optional() })
  .strict();
export type UpdateBreachRequest = z.infer<typeof UpdateBreachRequest>;

export const BreachListQuery = PaginationQuery.extend({
  severity: SeverityEnum.optional(),
}).strict();
export type BreachListQuery = z.infer<typeof BreachListQuery>;
