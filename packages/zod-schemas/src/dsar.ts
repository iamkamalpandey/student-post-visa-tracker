import { z } from 'zod';
import { PaginationQuery, Uuid } from './common.js';

export const DSARTypeEnum = z.enum([
  'ACCESS',
  'PORTABILITY',
  'ERASURE',
  'RECTIFICATION',
  'RESTRICTION',
  'OBJECTION',
]);
export type DSARType = z.infer<typeof DSARTypeEnum>;

export const DSARStatusEnum = z.enum([
  'PENDING',
  'IN_PROGRESS',
  'COMPLETED',
  'REJECTED',
  'EXPIRED',
]);
export type DSARStatus = z.infer<typeof DSARStatusEnum>;

export const CreateDSARRequest = z
  .object({
    subject_type: z.string().min(1).max(80),
    subject_id: Uuid,
    type: DSARTypeEnum,
    notes: z.string().max(2000).optional(),
  })
  .strict();
export type CreateDSARRequest = z.infer<typeof CreateDSARRequest>;

export const UpdateDSARRequest = z
  .object({
    status: DSARStatusEnum.optional(),
    export_storage_key: z.string().max(500).optional(),
    notes: z.string().max(2000).optional(),
  })
  .strict();
export type UpdateDSARRequest = z.infer<typeof UpdateDSARRequest>;

export const DSARListQuery = PaginationQuery.extend({
  status: DSARStatusEnum.optional(),
  type: DSARTypeEnum.optional(),
}).strict();
export type DSARListQuery = z.infer<typeof DSARListQuery>;

// SVT-WAVE-DSAR-PUBLIC-2026-05 — body for the public, unauthenticated DSAR
// intake endpoint (`POST /api/v1/public/dsar`). The endpoint always responds
// 200 with a generic message regardless of whether a matching subject exists,
// so this schema is purely for input validation; nothing in the response is
// derived from the body. `subject_type` is restricted to the two surfaces a
// data subject can plausibly self-identify under.
export const PublicDSARSubjectTypeEnum = z.enum(['student', 'user']);
export type PublicDSARSubjectType = z.infer<typeof PublicDSARSubjectTypeEnum>;

export const PublicDSARRequest = z
  .object({
    tenant_id: Uuid,
    subject_email: z.string().email().max(320),
    subject_type: PublicDSARSubjectTypeEnum,
    dsar_type: DSARTypeEnum,
    request_text: z.string().min(1).max(2000),
  })
  .strict();
export type PublicDSARRequest = z.infer<typeof PublicDSARRequest>;

// Row shape returned by GET /dsar (and decorated on /dsar/:id). The is_overdue /
// days_remaining pair is computed server-side so the FE doesn't have to repeat
// the GDPR / UK DPA 30-day clock logic.
export const DSARRow = z
  .object({
    id: Uuid,
    tenant_id: Uuid,
    subject_type: z.string(),
    subject_id: Uuid,
    type: DSARTypeEnum,
    status: DSARStatusEnum,
    requested_at: z.coerce.date(),
    due_by: z.coerce.date(),
    completed_at: z.coerce.date().nullable(),
    export_storage_key: z.string().nullable(),
    notes: z.string().nullable(),
    is_overdue: z.boolean(),
    days_remaining: z.number().int(),
  })
  .passthrough();
export type DSARRow = z.infer<typeof DSARRow>;
