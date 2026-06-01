// Per-request tenant scoping for Postgres RLS.
//
// Each authenticated request gets a Prisma client whose `$allOperations` extension wraps
// every query in a transaction that first sets `app.tenant_id` via `set_config(..., true)`
// (local-scope GUC) and then re-issues the operation on the *transactional* client so the
// RLS policies see the correct tenant id.
//
// Why dispatch on `tx` instead of calling `query(args)`: Prisma's extension `query`
// callback re-runs the operation against the original (unscoped) client, which would
// open a new connection without the GUC and the policy would block all rows. Re-issuing
// against `tx` keeps the work on the same connection where set_config ran.
//
// `set_config(..., true)` (the trailing `true` = local) auto-resets at tx-end so a
// connection returning to the pool never carries the previous tenant's id forward.

import type { Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/db.js';

// `req.db` and `req.tenantId` are augmented globally in `src/types/express.d.ts`.

function makeScopedClient(tenantId: string): typeof prisma {
  return prisma.$extends({
    name: 'tenantScope',
    query: {
      async $allOperations({ args, model, operation, query }) {
        return prisma.$transaction(async (tx) => {
          await tx.$executeRaw(
            Prisma.sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`,
          );
          if (!model) {
            // Raw operations ($queryRaw, $executeRaw) — re-run via the transactional
            // client by name so they actually use the same connection.
            const txAny = tx as unknown as Record<string, (...a: unknown[]) => unknown>;
            const fn = txAny[operation];
            if (typeof fn === 'function') {
              return fn.call(tx, args) as unknown as ReturnType<typeof query>;
            }
            return query(args);
          }
          // Model operations: dispatch on tx.<modelKey>.<operation>(args).
          const modelKey = model.charAt(0).toLowerCase() + model.slice(1);
          const txClient = tx as unknown as Record<string, Record<string, (a: unknown) => Promise<unknown>>>;
          const delegate = txClient[modelKey];
          if (delegate && typeof delegate[operation] === 'function') {
            return delegate[operation]!(args) as unknown as ReturnType<typeof query>;
          }
          return query(args);
        });
      },
    },
  }) as unknown as typeof prisma;
}

export async function tenantContext(req: Request, _res: Response, next: NextFunction): Promise<void> {
  if (!req.user) return next();
  req.tenantId = req.user.tid;
  req.db = makeScopedClient(req.user.tid);
  next();
}
