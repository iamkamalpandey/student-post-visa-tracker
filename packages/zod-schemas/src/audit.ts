// Zod schemas for the audit-logs read API. The audit table itself is INSERT-only
// (enforced by a trigger) so no Create/Update/Delete schemas are exposed.
import { z } from 'zod';
import { Iso8601DateTime, Uuid } from './common.js';

// Query params for GET /api/v1/audit-logs.
//
// - cursor   : opaque base64url-encoded `{created_at, id}` tuple. Pagination is
//              `created_at desc, id desc` so we need both fields to break ties.
// - limit    : 1..100, default 25. Matches the global PaginationQuery cap.
// - filters  : entity_type / entity_id / actor_id / action / from / to are all optional.
// - include_encrypted : when true AND caller is ADMIN we MAY surface before_enc/after_enc.
//                       For v1 the controller still strips them; the flag is reserved for
//                       a future step-up-auth flow.
export const AuditLogListQuery = z
  .object({
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    entity_type: z.string().min(1).max(120).optional(),
    entity_id: Uuid.optional(),
    actor_id: Uuid.optional(),
    action: z.string().min(1).max(120).optional(),
    from: Iso8601DateTime.optional(),
    to: Iso8601DateTime.optional(),
    include_encrypted: z
      .union([z.boolean(), z.enum(['true', 'false'])])
      .transform((v) => v === true || v === 'true')
      .optional(),
  })
  .strict();
export type AuditLogListQuery = z.infer<typeof AuditLogListQuery>;

// Single row shape returned to API clients. Ciphertext columns are intentionally absent
// — the controller selects them only when `include_encrypted` becomes a real feature.
export const AuditLogRow = z.object({
  id: Uuid,
  tenant_id: Uuid.nullable(),
  actor_id: Uuid.nullable(),
  actor_email_hash: z.string().nullable(),
  action: z.string(),
  entity_type: z.string(),
  entity_id: Uuid.nullable(),
  entity_version: z.number().int().nullable(),
  ip_hash: z.string().nullable(),
  ua_hash: z.string().nullable(),
  request_id: z.string().nullable(),
  prev_hash: z.string().nullable(),
  entry_hash: z.string(),
  created_at: z.string(), // ISO timestamp
});
export type AuditLogRow = z.infer<typeof AuditLogRow>;

// Paginated envelope. `total` is optional — the list endpoint may skip the COUNT(*) when
// filters are wide-open and the table is huge.
export const AuditLogListResponse = z.object({
  data: z.array(AuditLogRow),
  page: z.object({
    next_cursor: z.string().nullable(),
    total: z.number().int().nonnegative().optional(),
  }),
});
export type AuditLogListResponse = z.infer<typeof AuditLogListResponse>;

// Response from GET /api/v1/audit-logs/verify. broken_ids contains the audit_log.id values
// where the chain hash didn't match (i.e. tampering or storage corruption).
export const AuditLogVerifyResponse = z.object({
  data: z.object({
    tenant_id: Uuid,
    broken_count: z.number().int().nonnegative(),
    broken_ids: z.array(Uuid),
  }),
});
export type AuditLogVerifyResponse = z.infer<typeof AuditLogVerifyResponse>;
