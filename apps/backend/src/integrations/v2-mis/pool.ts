// SVT-V2-TRACKER-2026-06 — read-only connection pool to the external "V2 MIS"
// (TheNextMis) Postgres. Separate from Prisma deliberately: we issue exactly
// one read pass per sync, so a full second Prisma client/schema for V2's large
// schema would be overkill. Never log the connection string.

import pg from 'pg';
import { readFileSync } from 'node:fs';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

let pool: pg.Pool | null = null;
let readOnlyAsserted = false;

// Resolve the CA bundle for TLS verification: inline PEM or a filesystem path.
function resolveCa(): string | undefined {
  const ca = env.V2_MIS_DATABASE_CA;
  if (!ca) return undefined;
  if (ca.includes('BEGIN CERTIFICATE')) return ca; // inline PEM
  try {
    return readFileSync(ca, 'utf8'); // treat as a path
  } catch (err) {
    logger.error(
      { err, v2: true },
      'v2-mis: failed to read V2_MIS_DATABASE_CA file — falling back to unverified TLS',
    );
    return undefined;
  }
}

/**
 * Lazily construct the V2 pool. Throws if V2_MIS_DATABASE_URL is unset so
 * callers (the ingest job) fail loudly rather than silently no-op.
 */
export function getV2Pool(): pg.Pool {
  if (!env.V2_MIS_DATABASE_URL) {
    throw new Error('V2_MIS_DATABASE_URL is not configured');
  }
  if (!pool) {
    // Newer `pg` honours the URL's `sslmode` over the `ssl` client option, so a
    // `sslmode=require` in the string would force its own verification. Strip it
    // and let our explicit `ssl` option below govern.
    const useSsl = env.V2_MIS_DATABASE_SSL;
    const connectionString = useSsl
      ? env.V2_MIS_DATABASE_URL.replace(/[?&]sslmode=[^&]*/i, '')
      : env.V2_MIS_DATABASE_URL;

    let ssl: pg.PoolConfig['ssl'];
    if (useSsl) {
      const ca = resolveCa();
      if (ca) {
        // FINANCE-GRADE: verify the managed-DB cert chain against the pinned CA.
        ssl = { ca, rejectUnauthorized: true };
        logger.info({ v2: true }, 'v2-mis: TLS with CA verification enabled (rejectUnauthorized:true)');
      } else {
        // No CA — encrypted but UNVERIFIED. Acceptable for dev only; set
        // V2_MIS_DATABASE_CA in prod. Loud so it never slips into production.
        logger.warn(
          { v2: true },
          'v2-mis: TLS enabled WITHOUT CA verification (rejectUnauthorized:false) — set V2_MIS_DATABASE_CA for finance-grade verification',
        );
        ssl = { rejectUnauthorized: false };
      }
    }

    pool = new pg.Pool({
      connectionString,
      max: 3,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      ssl,
    });
    // Pool-level errors (idle client dropped by the server) must not crash the
    // process — log and let the next acquire reconnect.
    pool.on('error', (err) => {
      logger.error({ err, v2: true }, 'v2-mis pool error');
    });
  }
  return pool;
}

/**
 * SVT-SEC-2026-06 — Assert the connected V2 role is read-only, WITHOUT writing
 * anything to V2 (catalog + privilege reads only — respects "never touch MIS").
 * A superuser (e.g. `doadmin`) or a role holding INSERT on V2 tables can bypass
 * the `BEGIN TRANSACTION READ ONLY` guard, so we surface it loudly. Runs once
 * per process; safe to call inside the read-only ingest transaction.
 */
export async function assertV2ReadOnly(client: pg.PoolClient): Promise<void> {
  if (readOnlyAsserted || !env.V2_MIS_ASSERT_READONLY) return;
  readOnlyAsserted = true;
  try {
    const sup = await client.query<{ rolsuper: boolean }>(
      `SELECT rolsuper FROM pg_roles WHERE rolname = current_user`,
    );
    const isSuper = Boolean(sup.rows[0]?.rolsuper);
    let canWrite = false;
    try {
      const w = await client.query<{ can: boolean }>(
        `SELECT has_table_privilege(current_user, '"Lead"', 'INSERT') AS can`,
      );
      canWrite = Boolean(w.rows[0]?.can);
    } catch {
      // Privilege probe unavailable (table name differs) — the superuser flag
      // still covers the primary risk.
    }
    if (isSuper || canWrite) {
      logger.warn(
        { v2: true, isSuper, canWrite },
        'v2-mis: connected role has WRITE capability — create a dedicated read-only role on the V2 DB (see DEPLOY notes). Reads stay tx-READ-ONLY-guarded, but least-privilege is required for finance-grade.',
      );
    } else {
      logger.info({ v2: true }, 'v2-mis: connected role confirmed read-only (no superuser, no INSERT)');
    }
  } catch (err) {
    logger.warn({ err, v2: true }, 'v2-mis: read-only assertion check failed (non-fatal)');
  }
}

export async function disconnectV2Pool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
