/* eslint-disable no-console */
/*
 * SVT-AUDIT-OPS-2026-05 — Post-restore verifier.
 *
 * Confirms that a database restored from snapshot is structurally and
 * semantically sound:
 *   1. Critical tables exist and have non-zero row counts (configurable
 *      via MIN_EXPECTED_<TABLE> env, default 1 except audit_logs which is 0
 *      because brand-new tenants legitimately have no audit rows yet).
 *   2. The audit hash chain verifies clean for every tenant.
 *
 * Run with:
 *   DATABASE_URL=postgres://… \
 *     pnpm --filter backend tsx ../../infra/scripts/verify-restore.ts
 *
 * Exit codes:
 *   0  All checks passed.
 *   1  Anomaly detected. Stderr/Stdout contains the failing rows.
 *   2  Verifier itself crashed (DB unreachable, missing tables, etc.).
 *
 * See infra/docs/runbooks/db-backup-restore.md §5 (monthly drill).
 */

import { prisma } from '../../apps/backend/src/config/db.js';

interface TableCheck {
  /** Postgres table name. */
  table: string;
  /** Env var that overrides the minimum expected row count. */
  minEnv: string;
  /** Default minimum (used when minEnv is unset). */
  defaultMin: number;
}

const CRITICAL_TABLES: TableCheck[] = [
  { table: 'tenants', minEnv: 'MIN_EXPECTED_TENANTS', defaultMin: 1 },
  { table: 'users', minEnv: 'MIN_EXPECTED_USERS', defaultMin: 1 },
  { table: 'students', minEnv: 'MIN_EXPECTED_STUDENTS', defaultMin: 1 },
  { table: 'payments', minEnv: 'MIN_EXPECTED_PAYMENTS', defaultMin: 0 },
  { table: 'fee_plans', minEnv: 'MIN_EXPECTED_FEE_PLANS', defaultMin: 0 },
  // audit_logs may be 0 on a brand-new tenant; we still verify the chain below.
  { table: 'audit_logs', minEnv: 'MIN_EXPECTED_AUDIT_LOGS', defaultMin: 0 },
];

interface Anomaly {
  kind: 'row_count' | 'audit_chain' | 'missing_table';
  detail: string;
}

const anomalies: Anomaly[] = [];

function logSection(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function isSafeIdent(s: string): boolean {
  // We only ever pass hard-coded table names from CRITICAL_TABLES, but be
  // defensive — Prisma's $queryRawUnsafe with a non-identifier could be exploited
  // if this script grew an input source. Allow [a-z_]+ only.
  return /^[a-z_]+$/.test(s);
}

async function countRows(table: string): Promise<bigint | null> {
  if (!isSafeIdent(table)) {
    throw new Error(`Refusing to query suspicious table name: ${table}`);
  }
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ c: bigint }>>(
      `SELECT count(*)::bigint AS c FROM "${table}"`,
    );
    return rows[0]?.c ?? 0n;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/relation .* does not exist/i.test(msg)) {
      return null;
    }
    throw err;
  }
}

async function verifyRowCounts(): Promise<void> {
  logSection('Row counts');
  for (const check of CRITICAL_TABLES) {
    const min = process.env[check.minEnv]
      ? Number.parseInt(process.env[check.minEnv]!, 10)
      : check.defaultMin;
    const count = await countRows(check.table);
    if (count === null) {
      const detail = `table "${check.table}" does not exist`;
      console.error(`  ✗ ${detail}`);
      anomalies.push({ kind: 'missing_table', detail });
      continue;
    }
    const ok = count >= BigInt(min);
    const mark = ok ? '✓' : '✗';
    console.log(`  ${mark} ${check.table}: count=${count} (min=${min})`);
    if (!ok) {
      anomalies.push({
        kind: 'row_count',
        detail: `${check.table}: count=${count} < min=${min}`,
      });
    }
  }
}

async function verifyAuditChain(): Promise<void> {
  logSection('Audit hash chain');
  // Pull tenant ids; if `tenants` is missing we already reported that above.
  let tenantIds: string[] = [];
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id::text AS id FROM tenants ORDER BY id`,
    );
    tenantIds = rows.map((r) => r.id);
  } catch (err) {
    const detail = `cannot enumerate tenants: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`  ✗ ${detail}`);
    anomalies.push({ kind: 'audit_chain', detail });
    return;
  }
  if (tenantIds.length === 0) {
    console.log('  (no tenants — skipping chain verification)');
    return;
  }
  for (const tenantId of tenantIds) {
    try {
      const broken = await prisma.$queryRawUnsafe<Array<{ broken_id: string }>>(
        `SELECT broken_id FROM audit_logs_verify($1::uuid)`,
        tenantId,
      );
      if (broken.length === 0) {
        console.log(`  ✓ tenant=${tenantId} broken_count=0`);
      } else {
        const detail = `tenant=${tenantId} broken_count=${broken.length} first_ids=${broken
          .slice(0, 5)
          .map((b) => b.broken_id)
          .join(',')}`;
        console.error(`  ✗ ${detail}`);
        anomalies.push({ kind: 'audit_chain', detail });
      }
    } catch (err) {
      const detail = `tenant=${tenantId} audit_logs_verify failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
      console.error(`  ✗ ${detail}`);
      anomalies.push({ kind: 'audit_chain', detail });
    }
  }
}

async function main(): Promise<void> {
  console.log('verify-restore: starting');
  console.log(`  node=${process.version} pid=${process.pid}`);
  console.log(
    `  DATABASE_URL host=${
      process.env.DATABASE_URL?.replace(/.*@([^/?]+).*/, '$1') ?? '(unset)'
    }`,
  );

  await verifyRowCounts();
  await verifyAuditChain();

  logSection('Summary');
  if (anomalies.length === 0) {
    console.log('  PASS — no anomalies');
  } else {
    console.error(`  FAIL — ${anomalies.length} anomaly(ies):`);
    for (const a of anomalies) {
      console.error(`    - [${a.kind}] ${a.detail}`);
    }
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(anomalies.length === 0 ? 0 : 1);
  })
  .catch(async (err) => {
    console.error('verify-restore: crashed');
    console.error(err);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(2);
  });
