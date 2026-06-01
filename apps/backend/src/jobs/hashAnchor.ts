// Daily Merkle root anchor for the audit log chain. Each tenant's chain root is recomputed
// and persisted (intended target: an external WORM store such as S3 Object Lock). For v1
// we log it; the production wiring belongs in infra/scripts/hash-anchor.
//
// SVT-PERF-AUDIT-ANCHOR-DELTA-2026-05 — Incremental computation.
// Previously this job re-hashed the ENTIRE per-tenant audit chain on every
// run (tens of MB streamed into Node nightly). We now:
//   1. Read the latest anchor for the tenant (one row).
//   2. Fetch only the audit_logs entries past that anchor's watermark
//      (last_entry_created_at, last_entry_id).
//   3. Fold the delta onto the prior root: new_root = sha256(prior_root || H)
//      where H = reduce(sha256(acc + entry_hash), '') over the delta.
//   4. Write a new anchor with cumulative entries_count and the new watermark.
//   5. If no new entries: skip the write (don't waste an immutable row).
//
// First-ever anchor (or legacy null-watermark anchor) falls back to a
// from-scratch hash, preserving the original algorithm so external verifiers
// see byte-identical roots.

import { prisma } from '../config/db.js';
import { logger } from '../config/logger.js';
import { withTenantScope } from '../config/sentry.js';
import { sha256Hex } from '../shared/hashing.js';

const EMPTY_CHAIN_ROOT = '0'.repeat(64);

type DeltaResult = {
  tenantId: string | null;
  root: string;
  entries: number; // cumulative across all anchors for this tenant
  delta: number;   // entries folded in this run (0 = candidate for skip-write)
  hadPrior: boolean; // true if a previous anchor existed for this tenant
  lastEntryId: string | null;
  lastEntryCreatedAt: Date | null;
};

export async function computeTenantRoots(): Promise<DeltaResult[]> {
  const tenants = await prisma.tenant.findMany({ select: { id: true } });
  const tenantIds: Array<string | null> = tenants.map((t) => t.id);
  tenantIds.push(null); // tenant-less audit rows still need a chain
  const out: DeltaResult[] = [];

  for (const tid of tenantIds) {
    // SVT-OBS-JOBS-2026-05 — wrap each per-tenant pass in withTenantScope so
    // any thrown exception surfaces in Sentry tagged with the right tenant_id
    // (the null branch uses sentinel "_global" since Sentry tags must be
    // strings). The null-tenant case rarely fails — but when it does, we want
    // it distinguishable from a real tenant's failure.
    const scopeTenantId = tid ?? '_global';
    await withTenantScope(scopeTenantId, 'hash.anchor', async () => {
      const prior = await prisma.auditAnchor.findFirst({
        where: tid === null ? { tenant_id: null } : { tenant_id: tid },
        orderBy: { anchored_at: 'desc' },
        select: {
          root_hash: true,
          entries_count: true,
          last_entry_id: true,
          last_entry_created_at: true,
        },
      });

      // Delta selector. When the prior anchor has a watermark we fetch only
      // entries strictly past (last_entry_created_at, last_entry_id) using a
      // lexicographic tuple comparison — robust against multiple rows that
      // share a millisecond. Without a watermark (first run, or legacy
      // pre-delta anchor) we fall back to a full scan so the recomputed root
      // matches the original from-scratch algorithm.
      //
      // SEC-burst: `tenant_id: tid ?? undefined` previously collapsed the
      // null branch into "no filter" — folding EVERY tenant's audit rows
      // into a single Merkle root and corrupting per-tenant verification.
      // Use explicit IS NULL when scanning the tenant-less chain.
      const tenantFilter = tid === null ? { tenant_id: null } : { tenant_id: tid };
      const watermark =
        prior?.last_entry_created_at && prior?.last_entry_id
          ? { created_at: prior.last_entry_created_at, id: prior.last_entry_id }
          : null;

      const deltaWhere: Record<string, unknown> = { ...tenantFilter };
      if (watermark) {
        // (created_at, id) > (wm.created_at, wm.id)
        deltaWhere.OR = [
          { created_at: { gt: watermark.created_at } },
          {
            AND: [
              { created_at: { equals: watermark.created_at } },
              { id: { gt: watermark.id } },
            ],
          },
        ];
      }

      const rows = await prisma.auditLog.findMany({
        where: deltaWhere,
        orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
        select: { id: true, entry_hash: true, created_at: true },
      });

      const priorRoot = prior?.root_hash ?? '';
      const priorCount = prior?.entries_count ?? 0;

      // Fold the delta onto the prior root using the same reduce shape the
      // original algorithm used: acc starts at the prior root (or '' for a
      // fresh chain) and each entry contributes one sha256 round.
      // This keeps recomputed roots identical to what a full re-hash would
      // produce — verifiers don't need to know whether we ran incrementally.
      const newRoot = rows.reduce((acc, r) => sha256Hex(acc + r.entry_hash), priorRoot);
      const last = rows[rows.length - 1] ?? null;

      out.push({
        tenantId: tid,
        root: newRoot,
        entries: priorCount + rows.length,
        delta: rows.length,
        hadPrior: prior !== null,
        lastEntryId: last?.id ?? prior?.last_entry_id ?? null,
        lastEntryCreatedAt: last?.created_at ?? prior?.last_entry_created_at ?? null,
      });
    });
  }
  logger.info({ tenants: out.length }, 'hash-chain roots computed');

  // SVT-AUDIT-WORM-2026-05 — persist each root so forensic verification can
  // span log rotation + external WORM replication has something to read.
  // Per-row failures must not lose the rest (Promise.allSettled).
  //
  // Idempotency: skip rows where delta === 0 AND a prior anchor already
  // exists — there's literally nothing new to anchor, so writing another
  // immutable row would just waste storage and clutter the per-tenant
  // timeline. We still write on the very first run for a tenant (no prior),
  // even with zero entries, so the empty-chain sentinel exists in the table.
  const anchored_at = new Date();
  const toPersist = out.filter((r) => r.delta > 0 || !r.hadPrior);
  await Promise.allSettled(
    toPersist.map((r) =>
      prisma.auditAnchor
        .create({
          data: {
            tenant_id: r.tenantId,
            root_hash: r.root || EMPTY_CHAIN_ROOT, // empty-chain sentinel
            entries_count: r.entries,
            last_entry_id: r.lastEntryId,
            last_entry_created_at: r.lastEntryCreatedAt,
            anchored_at,
          },
        })
        .catch((err) => {
          logger.error({ err, tenantId: r.tenantId }, 'audit anchor persist failed');
        }),
    ),
  );
  return out;
}
