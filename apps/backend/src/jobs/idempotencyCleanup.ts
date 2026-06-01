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
import { prisma } from '../config/db.js';
import { logger } from '../config/logger.js';

export async function runIdempotencyCleanup(): Promise<{ deleted: number }> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24h grace beyond expires_at
  const r = await prisma.idempotencyRecord.deleteMany({
    where: { expires_at: { lt: cutoff } },
  });
  if (r.count > 0) logger.info({ deleted: r.count }, 'idempotency cleanup');
  return { deleted: r.count };
}
