// SVT-QA-2026-08 — shared tenant-scoped transaction helper.
//
// Under the future `spv_app` runtime role every RLS-tagged table filters rows
// against `app_current_tenant()`. That GUC is only set inside the request-
// scoped Prisma extension (middlewares/tenantContext.ts) — service functions
// that reach for the raw `prisma` singleton bypass the extension, so their
// queries see zero rows when RLS is enforced.
//
// This helper wraps an arbitrary Prisma workload in a single transaction that
// first `set_config('app.tenant_id', ..., true)`s the tenant GUC + then runs
// the caller's body against the transactional client. Mirrors the per-request
// extension for non-request contexts (jobs, seed, service functions called
// outside the HTTP boundary).
//
// Callers that already have `req.db` (the extended client) MUST prefer that
// path — it batches every operation into its own tiny scoped tx automatically
// and is cheaper per call.

import { Prisma } from '@prisma/client';
import { prisma } from '../config/db.js';

export async function withTenantTx<T>(
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw(
      Prisma.sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`,
    );
    return fn(tx);
  });
}
