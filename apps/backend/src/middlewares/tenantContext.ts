// Per-request tenant scoping for Postgres RLS.
//
// Each authenticated request gets a Prisma client whose `$allOperations`
// extension runs every query inside a transaction that first sets
// `app.tenant_id` via `set_config(..., true)` (local-scope GUC), so the RLS
// policies see the correct tenant id. The trailing `true` means the GUC
// auto-resets at transaction end, so a connection returning to the pool never
// carries the previous tenant's id forward.
//
// ---------------------------------------------------------------------------
// SVT-PERF-2026-08 — two changes here, both cost-driven, neither weakening RLS.
//
// 1) BATCHED TRANSACTION instead of an interactive one.
//
//    The previous implementation used the interactive form:
//
//      prisma.$transaction(async (tx) => {
//        await tx.$executeRaw`SELECT set_config(...)`;   // round-trip
//        return tx.<model>.<op>(args);                   // round-trip
//      });
//
//    An interactive transaction is a conversation: the driver issues BEGIN,
//    waits, issues set_config, waits, issues the query, waits, issues COMMIT,
//    waits. That is FOUR network round-trips for ONE logical query, and the
//    pool connection is held for all four. An endpoint issuing 8 queries paid
//    32 round-trips and checked a connection in and out 8 times.
//
//    Prisma's ARRAY form pipelines the whole batch to the server in a single
//    exchange. Prisma promises are lazy — building `prisma.student.findMany(args)`
//    does not execute anything until it is awaited or handed to $transaction —
//    so we can construct the operation, put it after the set_config statement,
//    and let Prisma ship both together. Same transaction, same connection, same
//    GUC semantics; roughly a quarter of the round-trips and a quarter of the
//    pool-checkout churn.
//
//    This is the documented Prisma pattern for RLS. It is NOT a relaxation:
//    both statements still run inside one transaction on one connection, and
//    the GUC is still local-scoped.
//
// 2) MEMOIZED CLIENT per tenant.
//
//    `makeScopedClient` was called on every single request, and `$extends`
//    builds a fresh proxy over the entire client surface each time. That is
//    pure allocation churn on the hottest path in the app. The extension
//    closes over nothing but `tenantId`, so one client per tenant is safe to
//    reuse for the process lifetime. The cache is bounded so a pathological
//    tenant count cannot grow it without limit.
// ---------------------------------------------------------------------------

import type { Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/db.js';

// `req.db` and `req.tenantId` are augmented globally in `src/types/express.d.ts`.

// Bounded LRU-ish cache. A single deployment serves a handful of tenants, so
// this effectively never evicts; the cap exists so a misconfigured caller
// (or a future multi-thousand-tenant deployment) cannot leak memory.
const MAX_CACHED_CLIENTS = 512;
const scopedClientCache = new Map<string, typeof prisma>();

/** Test/ops hook — drop memoized clients (e.g. after a pool reset). */
export function __clearScopedClientCache(): void {
  scopedClientCache.clear();
}

function buildScopedClient(tenantId: string): typeof prisma {
  const setTenant = Prisma.sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`;

  return prisma.$extends({
    name: 'tenantScope',
    query: {
      async $allOperations({ args, model, operation, query }) {
        // Raw operations ($queryRaw/$executeRaw) still need the interactive
        // form: they are dispatched by name off the transactional client and
        // are rare enough that the extra round-trips don't matter.
        if (!model) {
          return prisma.$transaction(async (tx) => {
            await tx.$executeRaw(setTenant);
            const txAny = tx as unknown as Record<string, (...a: unknown[]) => unknown>;
            const fn = txAny[operation];
            if (typeof fn === 'function') {
              return fn.call(tx, args) as unknown as ReturnType<typeof query>;
            }
            return query(args);
          });
        }

        const modelKey = model.charAt(0).toLowerCase() + model.slice(1);
        const baseClient = prisma as unknown as Record<
          string,
          Record<string, (a: unknown) => Prisma.PrismaPromise<unknown>>
        >;
        const delegate = baseClient[modelKey];
        const opFn = delegate?.[operation];

        // Unknown model/operation pairing — fall back to the interactive form
        // rather than guessing. Correctness over cleverness.
        if (typeof opFn !== 'function') {
          return prisma.$transaction(async (tx) => {
            await tx.$executeRaw(setTenant);
            return query(args);
          });
        }

        // Lazy PrismaPromise — nothing has hit the database yet.
        const pending = opFn.call(delegate, args);
        const [, result] = await prisma.$transaction([
          prisma.$executeRaw(setTenant),
          pending,
        ]);
        return result as unknown as ReturnType<typeof query>;
      },
    },
  }) as unknown as typeof prisma;
}

function makeScopedClient(tenantId: string): typeof prisma {
  const cached = scopedClientCache.get(tenantId);
  if (cached) return cached;
  if (scopedClientCache.size >= MAX_CACHED_CLIENTS) {
    // Evict the oldest insertion; Map preserves insertion order.
    const oldest = scopedClientCache.keys().next();
    if (!oldest.done) scopedClientCache.delete(oldest.value);
  }
  const built = buildScopedClient(tenantId);
  scopedClientCache.set(tenantId, built);
  return built;
}

export async function tenantContext(req: Request, _res: Response, next: NextFunction): Promise<void> {
  if (!req.user) return next();
  req.tenantId = req.user.tid;
  req.db = makeScopedClient(req.user.tid);
  next();
}
