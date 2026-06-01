// Audit-log read service.
//
// The audit_logs table is INSERT-only (DB trigger enforces this — see
// `audit_logs_block_update_delete` in the migrations). Therefore this service exposes
// only read paths: list, getById, verify.
//
// All callers MUST pass the RLS-scoped `req.db` from tenantContext middleware. We
// deliberately do NOT fall back to the singleton: the audit log is the most
// security-sensitive table in the system and accidentally bypassing RLS would leak
// cross-tenant rows.
import type { Prisma, PrismaClient } from '@prisma/client';
import { logger } from '../../config/logger.js';
import { InternalError, NotFound } from '../../shared/errors.js';
import type { AuditLogListQuery } from '@spv/zod-schemas';

export type Db = PrismaClient;

// Opaque cursor: base64url-encoded JSON of the (created_at, id) tuple from the last
// row of the previous page. Pagination is `created_at desc, id desc`.
type CursorParts = { created_at: string; id: string };

function encodeCursor(parts: CursorParts): string {
  return Buffer.from(JSON.stringify(parts), 'utf8').toString('base64url');
}

function decodeCursor(s: string): CursorParts | null {
  try {
    const obj = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as CursorParts;
    if (typeof obj?.created_at !== 'string' || typeof obj?.id !== 'string') return null;
    return obj;
  } catch {
    return null;
  }
}

// Columns returned to API clients. before_enc / after_enc are intentionally excluded —
// surfacing the ciphertext is reserved for a future step-up-auth flow.
const SELECT_PUBLIC = {
  id: true,
  tenant_id: true,
  actor_id: true,
  actor_email_hash: true,
  action: true,
  entity_type: true,
  entity_id: true,
  entity_version: true,
  ip_hash: true,
  ua_hash: true,
  request_id: true,
  prev_hash: true,
  entry_hash: true,
  created_at: true,
} as const;

type Ctx = { db: Db; tenantId: string };

export async function list(
  ctx: Ctx,
  q: AuditLogListQuery,
): Promise<{ data: unknown[]; nextCursor: string | null; total: number }> {
  const { db, tenantId } = ctx;
  const limit = q.limit;

  // Tenant scoping. RLS will also enforce this but the explicit predicate keeps the
  // query plan stable and makes the SQL self-documenting.
  const where: Prisma.AuditLogWhereInput = { tenant_id: tenantId };

  if (q.entity_type) where.entity_type = q.entity_type;
  if (q.entity_id) where.entity_id = q.entity_id;
  if (q.actor_id) where.actor_id = q.actor_id;
  // SVT-WAVE59-AUDIT-PREFIX-2026-05 — action filter accepts a trailing '*'
  // wildcard so admins can scope by family ("breach.*", "dsar.*", "auth.*").
  // No wildcard preserves the exact-match semantics existing callers rely on.
  if (q.action) {
    if (q.action.endsWith('*')) {
      const prefix = q.action.slice(0, -1);
      if (prefix.length > 0) {
        where.action = { startsWith: prefix };
      }
    } else {
      where.action = q.action;
    }
  }

  // Date-range filter on created_at. Both bounds optional, both inclusive of the lower
  // bound and exclusive of the upper for predictable behaviour around midnight rollovers.
  if (q.from || q.to) {
    where.created_at = {};
    if (q.from) where.created_at.gte = new Date(q.from);
    if (q.to) where.created_at.lt = new Date(q.to);
  }

  // Cursor seek on (created_at, id). Same pattern as students.service so reviewers
  // recognise it.
  const cursor = q.cursor ? decodeCursor(q.cursor) : null;
  if (cursor) {
    where.AND = [
      ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
      {
        OR: [
          { created_at: { lt: new Date(cursor.created_at) } },
          { created_at: new Date(cursor.created_at), id: { lt: cursor.id } },
        ],
      },
    ];
  }

  // take=limit+1 lets us detect a next page without a second round-trip.
  const rowsP = db.auditLog.findMany({
    where,
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: SELECT_PUBLIC,
  });
  const totalP = db.auditLog.count({ where });
  const [rowsPlusOne, total] = await Promise.all([rowsP, totalP]);

  const hasMore = rowsPlusOne.length > limit;
  const rows = hasMore ? rowsPlusOne.slice(0, limit) : rowsPlusOne;
  const last = rows[rows.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeCursor({ created_at: last.created_at.toISOString(), id: last.id })
      : null;

  return { data: rows, nextCursor, total };
}

export async function getById(ctx: Ctx, id: string): Promise<unknown> {
  const row = await ctx.db.auditLog.findFirst({
    where: { id, tenant_id: ctx.tenantId },
    select: SELECT_PUBLIC,
  });
  if (!row) throw NotFound('Audit log entry not found');
  return row;
}

// Calls Postgres function `audit_logs_verify(p_tenant uuid)` which walks every row in
// the tenant's chain and returns the ids of any rows whose entry_hash doesn't match
// sha256(prev_hash || canonical_payload). Empty result => chain intact.
export async function verify(
  ctx: Ctx,
): Promise<{ tenant_id: string; broken_count: number; broken_ids: string[] }> {
  const { db, tenantId } = ctx;
  let rows: Array<{ broken_id: string }> = [];
  try {
    // Postgres returns the function as a SETOF row; Prisma's $queryRaw maps to JS
    // objects keyed by column name (`broken_id`).
    rows = await db.$queryRaw<Array<{ broken_id: string }>>`
      SELECT broken_id FROM audit_logs_verify(${tenantId}::uuid)
    `;
  } catch (err) {
    logger.error({ err, tenantId }, 'audit_logs_verify call failed');
    throw InternalError('Audit chain verification failed');
  }

  const broken_ids = rows.map((r) => r.broken_id);
  const broken_count = broken_ids.length;

  if (broken_count > 0) {
    // Loud, structured error so SREs can wire alerts to it. Tampering with the audit
    // log is a Sev1 event by definition.
    logger.error(
      { tenantId, broken_count, broken_ids },
      'Audit chain verification found broken entries — possible tampering or storage corruption',
    );
  }

  return { tenant_id: tenantId, broken_count, broken_ids };
}
