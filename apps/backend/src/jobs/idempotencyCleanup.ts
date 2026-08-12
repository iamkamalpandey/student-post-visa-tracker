// Idempotency-records cleanup job.
//
// `idempotency_records` is append-mostly: a row is inserted per write request
// that carries an Idempotency-Key. Without periodic deletion the table grows
// monotonically — TTL is currently enforced only at lookup time (callers
// filter by `expires_at > now()`) so expired rows linger forever.
//
// This job sweeps rows whose `expires_at` is older than `now() - 24h`. The
// 24h grace beyond `expires_at` is intentional: it gives engineers a window
// to inspect a recently-expired idempotency record while debugging without
// racing the cleanup pass. Cadence is daily at 02:00 UTC (low-traffic window).
//
// The deleteMany uses the existing `@@index([expires_at])` on
// IdempotencyRecord, so the scan stays cheap as the table grows.
// SVT-SEC-2026-08 (T0-7) — prismaAdmin, not prisma.
//
// idempotency_records is RLS-scoped, and this sweep carries no tenant filter by
// design: it is a whole-table maintenance purge keyed purely on time. On the
// GUC-less runtime singleton that deleteMany matched ZERO rows under the
// production role, so the table grew forever — the exact unbounded growth this
// job exists to prevent — while reporting `deleted: 0` as though there had been
// nothing to do.
//
// Sweeping tenant-by-tenant would be the wrong shape here: the rows being purged
// are expired protocol bookkeeping, not tenant data being read, and a per-tenant
// loop would add round-trips for no isolation benefit on a time-based purge.
// Cross-tenant reach is the requirement, so the admin client is the honest tool
// and the call is greppable as such.
import { prismaAdmin } from '../config/db.js';
import { logger } from '../config/logger.js';

export async function runIdempotencyCleanup(): Promise<{ deleted: number }> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24h grace beyond expires_at
  const r = await prismaAdmin.idempotencyRecord.deleteMany({
    where: { expires_at: { lt: cutoff } },
  });
  if (r.count > 0) logger.info({ deleted: r.count }, 'idempotency cleanup');
  return { deleted: r.count };
}
