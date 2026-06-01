// Postgres advisory-lock helper for the background scheduler.
//
// `withJobLock(name, ttlSec, fn)` attempts to take a session-scoped Postgres
// advisory lock keyed by an FNV-1a 64-bit hash of `name`. If the lock is held
// by another process / replica, the helper returns `null` immediately so the
// caller can record a SKIPPED_LOCKED JobRun and move on.
//
// SVT-SEC-2026-05 — Fail-CLOSED on advisory-lock SQL failure.
//   Previously this helper degraded to running the job WITHOUT a lock when
//   pg_try_advisory_lock failed (e.g. Postgres pressure, connection blip).
//   That defeated multi-replica safety on the exact failure mode where
//   duplicate runs are most damaging. The helper now throws so the runner
//   records FAILED and the next cycle retries — exactly once per cycle.
//
// OPERATOR NOTE — PgBouncer transaction-pooling compatibility:
//   session-scoped pg_try_advisory_lock requires the lock and the unlock to
//   reach the SAME Postgres backend. PgBouncer in transaction-pooling mode
//   (default for Neon/Supabase pooled endpoints) returns the connection to
//   the pool between statements, so the lock may release immediately and
//   the unlock may run on a different backend. Two safe deployments:
//     1. Point DATABASE_URL at the **direct** (session-pooling or no-pgbouncer)
//        Postgres endpoint for the API process that runs the scheduler.
//     2. Or run the scheduler in a single replica (SVT_SCHEDULER_ENABLED=true
//        on one replica, false on the others) and skip advisory locking.
//   Multi-replica + transaction-pooling without a session-pinned connection
//   has no clean solution at the Prisma layer today; a v2 option is to swap
//   to pg-boss or an external cron service (k8s CronJob).

import { prisma } from '../config/db.js';
import { logger } from '../config/logger.js';

/**
 * Run `fn` while holding a Postgres advisory lock named `jobName`.
 *
 * Returns the function's result on success, or `null` when the lock was
 * already held (i.e. another replica is running the same job — the caller
 * should record a SKIPPED_LOCKED JobRun). Throws when the advisory-lock
 * SQL itself fails (fail-CLOSED).
 */
export async function withJobLock<T>(
  jobName: string,
  ttlSec: number,
  fn: () => Promise<T>,
): Promise<T | null> {
  const lockKey = hashToBigint(jobName);

  let acquired = false;
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ ok: boolean }>>(
      `SELECT pg_try_advisory_lock($1::bigint) AS ok`,
      lockKey,
    );
    acquired = Boolean(rows[0]?.ok);
  } catch (err) {
    // Fail-CLOSED. If Postgres can't even tell us whether the lock is free,
    // running the job is the wrong call — multi-replica deployments would
    // double-fire on transient pressure. Surface and skip this cycle.
    logger.error(
      { err, jobName, ttlSec },
      'withJobLock: advisory lock query failed — fail-CLOSED (run skipped)',
    );
    throw err;
  }

  if (!acquired) return null;
  try {
    return await fn();
  } finally {
    try {
      await prisma.$executeRawUnsafe(`SELECT pg_advisory_unlock($1::bigint)`, lockKey);
    } catch (err) {
      logger.warn({ err, jobName }, 'withJobLock: failed to release advisory lock');
    }
  }
}

/**
 * Stable FNV-1a 64-bit hash of an ASCII job name, masked into a positive
 * signed bigint so Postgres' bigint advisory-lock parameter accepts it.
 */
export function hashToBigint(s: string): bigint {
  let h = 0xcbf29ce484222325n;
  const FNV_PRIME = 0x100000001b3n;
  const MASK_64 = 0xffffffffffffffffn;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * FNV_PRIME) & MASK_64;
  }
  // Postgres' bigint is signed; mask high bit so we always pass a positive
  // value and avoid surprising sign-flips at the SQL boundary.
  return h & 0x7fffffffffffffffn;
}
